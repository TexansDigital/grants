-- 0014_report_drafts.sql
--
-- Where a grantee's half-finished report lives.
--
-- THE PROBLEM THIS SOLVES. 0012 defines report_submissions as "what a grantee
-- filed... one row per attempt, never overwritten", with submitted_at NOT NULL
-- and a trigger that refuses to rewrite a filed report. That is the right shape
-- for a record and the wrong shape for a draft, and the grantee portal needs
-- both: "save and return" is not a nicety for somebody filling this in between
-- two other jobs.
--
-- THREE WAYS NOT TO DO IT, and why:
--
--   Create the submission row at first save and set submitted_at to whenever
--   the draft was started. That puts a false timestamp in a financial record,
--   and 0012's trigger then refuses to correct it at filing time.
--
--   Make submitted_at nullable. SQLite cannot drop NOT NULL with ALTER TABLE,
--   so this means rebuilding a table that report_answers and metric_values
--   hold foreign keys into -- a drop-and-rename that SQLite refuses outright
--   while those references exist, unless legacy_alter_table is on. Not
--   something to attempt inside a D1 migration to buy a nullable column.
--
--   A second typed answers table for drafts. A third copy of the same four
--   value columns, and the copy logic between them, to hold work in progress.
--
-- WHAT THIS IS INSTEAD. A draft is the browser's working state, kept server-
-- side so it survives a closed laptop and moves to a phone. It is not a
-- record, and it is deliberately NOT typed into value_text/value_int/
-- value_real/value_json: it is the raw keyed object the form posts, stored as
-- it arrives. Typing happens once, at submit, against the pinned form
-- definition -- which is the only moment the answers are authoritative anyway.
--
-- That is the whole distinction. report_drafts is scratch; report_submissions
-- and report_answers are the record. A draft can be overwritten a hundred
-- times and nobody needs to know; a submission cannot be overwritten at all.

CREATE TABLE report_drafts (
  id                    TEXT PRIMARY KEY,
  report_period_id      TEXT NOT NULL REFERENCES report_periods(id),

  -- Denormalized from the award, so that "is this draft yours" is one indexed
  -- lookup on the session's organization rather than a three-table join on
  -- every autosave. Kept honest by the triggers below rather than by the code
  -- that happens to write it.
  organization_id       TEXT NOT NULL REFERENCES organizations(id),

  -- The form this draft's keys belong to, copied from the period when the
  -- draft is started. A period's form is pinned at generation and a published
  -- form cannot change, so this is stable -- it is recorded here so that a
  -- draft whose period is later re-pointed at a different form is detectable
  -- rather than silently re-interpreted under the new field keys.
  form_definition_id    TEXT NOT NULL REFERENCES form_definitions(id),

  -- The raw posted object, keyed by field_key. Never read as a record; only
  -- ever re-validated against the form definition.
  answers_json          TEXT NOT NULL,

  updated_at            TEXT NOT NULL,
  updated_by_user_id    TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL,

  -- Set when this draft became a submission. From that moment it is history:
  -- a revision opens a NEW draft, so the working state that produced each
  -- filed report is still there to look at.
  submitted_at          TEXT,
  report_submission_id  TEXT REFERENCES report_submissions(id),

  deleted_at            TEXT,

  CHECK (json_valid(answers_json)),
  -- A ceiling well above any real report and well below D1's 2 MB row limit.
  -- A draft that hits this is a paste of something that belongs in an upload.
  CHECK (length(answers_json) <= 400000),
  CHECK ((submitted_at IS NOT NULL) = (report_submission_id IS NOT NULL))
);

-- One open draft per period. Two would mean an autosave from a phone and an
-- autosave from a laptop each building a different report, and whichever was
-- filed second would quietly be the one that counted.
CREATE UNIQUE INDEX report_drafts_open_uniq
  ON report_drafts (report_period_id)
  WHERE submitted_at IS NULL AND deleted_at IS NULL;

CREATE INDEX report_drafts_org_idx
  ON report_drafts (organization_id, updated_at);

-- Scratch or not, it is attached to a financial record and it is what somebody
-- typed. Soft-delete only, same as everything else here.
CREATE TRIGGER report_drafts_no_delete
BEFORE DELETE ON report_drafts
BEGIN
  SELECT RAISE(ABORT, 'report drafts are soft-deleted, never removed');
END;

-- The denormalized organization must be the one that holds the award. Getting
-- this wrong is not a display bug: it is the column every scoped query filters
-- on, so a wrong value shows one nonprofit another nonprofit's report.
CREATE TRIGGER report_drafts_organization_matches_award_insert
BEFORE INSERT ON report_drafts
WHEN NEW.organization_id IS NOT (
  SELECT a.organization_id FROM report_periods rp
    JOIN awards a ON a.id = rp.award_id
   WHERE rp.id = NEW.report_period_id
)
BEGIN
  SELECT RAISE(ABORT, 'a report draft must belong to the organization that holds the award');
END;

CREATE TRIGGER report_drafts_organization_matches_award_update
BEFORE UPDATE ON report_drafts
WHEN NEW.organization_id IS NOT (
  SELECT a.organization_id FROM report_periods rp
    JOIN awards a ON a.id = rp.award_id
   WHERE rp.id = NEW.report_period_id
)
BEGIN
  SELECT RAISE(ABORT, 'a report draft must belong to the organization that holds the award');
END;

-- A draft that has been filed is finished. Editing its answers afterwards would
-- change the working state that produced a filed report, after the fact.
CREATE TRIGGER report_drafts_filed_is_final
BEFORE UPDATE ON report_drafts
WHEN OLD.submitted_at IS NOT NULL
 AND (NEW.answers_json <> OLD.answers_json
   OR NEW.submitted_at IS NOT OLD.submitted_at
   OR NEW.report_submission_id IS NOT OLD.report_submission_id)
BEGIN
  SELECT RAISE(ABORT, 'this draft has already been filed');
END;
