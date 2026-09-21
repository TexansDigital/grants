-- 0023_conflict_cleared.sql
--
-- A declared conflict that turns out not to be one.
--
-- THE DEAD END THIS FIXES. A reviewer who says "I think I know somebody on
-- that board" has, today, made an irreversible statement. Scoring on the
-- assignment is refused from that moment, and the only exits are recusal --
-- which loses the reviewer for that application -- or nothing at all, which
-- leaves the assignment blocked and counting as covered. So the safe act, for
-- the reviewer, is to say nothing until they are sure. That is precisely
-- backwards: CLAUDE.md puts disclosure at assignment rather than at scoring
-- because "a conflict discovered while scoring has already contaminated the
-- score", and a policy that penalizes early disclosure produces late
-- disclosure.
--
-- WHAT THIS IS NOT. It is not an undo. `conflict_declared_at` and the note
-- that came with it are untouched: the declaration happened, and what a
-- conflict-of-interest record is FOR is answering, later, what was disclosed
-- and what was done about it. A clear is a second event recorded beside the
-- first, with its own actor, its own time, and its own words appended to the
-- note.
--
-- ADMIN ONLY, enforced in the library. A reviewer clearing their own
-- declaration is the one thing a conflict policy exists to prevent.

ALTER TABLE review_assignments ADD COLUMN conflict_cleared_at TEXT;
ALTER TABLE review_assignments ADD COLUMN conflict_cleared_by TEXT REFERENCES users(id);

-- A clear with no declaration behind it is a record of resolving nothing.
CREATE TRIGGER review_conflict_cleared_needs_a_declaration_insert
BEFORE INSERT ON review_assignments
WHEN NEW.conflict_cleared_at IS NOT NULL AND NEW.conflict_declared_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a conflict cannot be cleared before it is declared');
END;

CREATE TRIGGER review_conflict_cleared_needs_a_declaration_update
BEFORE UPDATE OF conflict_cleared_at, conflict_declared_at ON review_assignments
WHEN NEW.conflict_cleared_at IS NOT NULL AND NEW.conflict_declared_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a conflict cannot be cleared before it is declared');
END;

-- Who and when, together or not at all. A timestamp with no actor cannot
-- answer the question it exists for -- the same rule 0020 applies to an award
-- acceptance, and for the same reason.
CREATE TRIGGER review_conflict_cleared_is_complete_insert
BEFORE INSERT ON review_assignments
WHEN (NEW.conflict_cleared_at IS NOT NULL) <> (NEW.conflict_cleared_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'clearing a conflict records who cleared it and when');
END;

CREATE TRIGGER review_conflict_cleared_is_complete_update
BEFORE UPDATE OF conflict_cleared_at, conflict_cleared_by ON review_assignments
WHEN (NEW.conflict_cleared_at IS NOT NULL) <> (NEW.conflict_cleared_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'clearing a conflict records who cleared it and when');
END;

-- "Which assignments are blocked by an unresolved disclosure." Partial,
-- because in a healthy cycle this is a handful of rows out of hundreds, and it
-- is the question the coverage screen asks on every load.
CREATE INDEX review_assignments_conflict_outstanding_idx
  ON review_assignments (application_id)
  WHERE conflict_declared_at IS NOT NULL
    AND conflict_cleared_at IS NULL
    AND recused_at IS NULL
    AND deleted_at IS NULL;
