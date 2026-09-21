-- 0024_award_amendments.sql
--
-- Changing an award, with a record of the change.
--
-- WHAT WAS WRONG. 0012 refuses to let `awarded_amount_cents` be updated at
-- all: "an awarded amount changes through an amendment, not an update", with
-- the amendments table left to Phase 4. Phase 4 came and went. So an award
-- recorded at the wrong amount -- a misplaced decimal, a board number the
-- committee revised the following week -- could not be corrected through this
-- system in any way. The documented remedy was "a conversation, not an
-- UPDATE", which in practice means somebody editing the production database by
-- hand: the one thing CLAUDE.md forbids outright.
--
-- The term dates were worse, because nothing stopped those being overwritten
-- silently, and every report due date on the grant is generated from them.
--
-- WHY A TABLE AND NOT JUST THE AUDIT LOG. The audit log answers "what happened
-- to this row" for everything in the system, and is read by whoever is
-- debugging. An award's amendment history is read by the grantee's program
-- officer, quoted back in a letter, and is part of what the grant IS -- "$25,000,
-- amended to $18,000 on 14 March because the partner site withdrew". CLAUDE.md
-- names the table and its columns for that reason. Both are written; neither
-- replaces the other.
--
-- THE TRIGGER IS THE POINT. It is not enough to have somewhere to record an
-- amendment; the amount must be UNABLE to move without one. The replacement
-- trigger below lets the update through only when a matching amendment row
-- already exists, stamped at the same instant -- which, in a D1 batch, means
-- the INSERT has to be ordered before the UPDATE. Nothing else can change that
-- column.

CREATE TABLE award_amendments (
  id            TEXT PRIMARY KEY,
  award_id      TEXT NOT NULL REFERENCES awards(id),
  amended_at    TEXT NOT NULL,
  -- Who decided. Not nullable: an amendment nobody is named on is the gap the
  -- table exists to close.
  amended_by    TEXT NOT NULL REFERENCES users(id),

  -- One row per field, so "the amount changed AND the term was extended" is
  -- two facts rather than one blob somebody has to diff.
  field_changed TEXT NOT NULL
                  CHECK (field_changed IN (
                    'awarded_amount_cents', 'term_start', 'term_end',
                    'announcement_date'
                  )),
  -- TEXT for both, because the four fields are not one type. Money is the
  -- integer cents as a string; the dates are ISO-8601. Never formatted: a
  -- record that says "$18,000" cannot be compared with the column it came from.
  old_value     TEXT,
  new_value     TEXT,

  -- REQUIRED, and enforced here rather than only in the library. "Why" is the
  -- whole content of an amendment; the amount is already on the award.
  reason        TEXT NOT NULL CHECK (TRIM(reason) <> ''),

  created_at    TEXT NOT NULL,

  -- An amendment that changes nothing is a row somebody has to explain.
  CHECK (old_value IS NOT new_value)
);

CREATE INDEX award_amendments_award_idx
  ON award_amendments (award_id, amended_at);

-- APPEND-ONLY, like audit_log. An amendment history that can be rewritten
-- answers nothing, and these describe money.
CREATE TRIGGER award_amendments_no_update
BEFORE UPDATE ON award_amendments
BEGIN
  SELECT RAISE(ABORT, 'award amendments are append-only');
END;

CREATE TRIGGER award_amendments_no_delete
BEFORE DELETE ON award_amendments
BEGIN
  SELECT RAISE(ABORT, 'award amendments are append-only');
END;

-- Replaces 0012's blanket refusal. The amount may move ONLY when this exact
-- move is already recorded, stamped at the same instant as the update -- so a
-- stale amendment row from an earlier change cannot be reused to wave a later
-- one through.
DROP TRIGGER awards_amount_is_not_edited_in_place;

CREATE TRIGGER awards_amount_needs_an_amendment
BEFORE UPDATE OF awarded_amount_cents ON awards
WHEN NEW.awarded_amount_cents <> OLD.awarded_amount_cents
 AND NOT EXISTS (
   SELECT 1 FROM award_amendments
    WHERE award_id = NEW.id
      AND field_changed = 'awarded_amount_cents'
      AND old_value = CAST(OLD.awarded_amount_cents AS TEXT)
      AND new_value = CAST(NEW.awarded_amount_cents AS TEXT)
      AND amended_at = NEW.updated_at
 )
BEGIN
  SELECT RAISE(ABORT, 'an awarded amount changes through an amendment, not an update');
END;

-- The term dates were never guarded at all, and every report due date on the
-- grant is generated from them. Same rule, same reason.
CREATE TRIGGER awards_term_needs_an_amendment
BEFORE UPDATE OF term_start, term_end ON awards
WHEN (NEW.term_start IS NOT OLD.term_start OR NEW.term_end IS NOT OLD.term_end)
 AND NOT EXISTS (
   SELECT 1 FROM award_amendments
    WHERE award_id = NEW.id
      AND field_changed IN ('term_start', 'term_end')
      AND amended_at = NEW.updated_at
 )
BEGIN
  SELECT RAISE(ABORT, 'a grant term changes through an amendment, not an update');
END;
