-- 0019_decision_communication.sql
--
-- Whether the applicant has been told.
--
-- THE PROBLEM THIS FIXES, found while answering "should declined applicants
-- keep portal access". They should, and there should be nothing for them
-- there -- which is already true. What was NOT true is that the portal kept
-- the decision to itself until somebody communicated it.
--
-- `applications.status` becomes 'declined' the moment an admin records the
-- decision, and the applicant's own portal reads that column. So a nonprofit
-- signing in on Tuesday would have learned it was declined from a status
-- badge, days before the letter a human was still writing. CLAUDE.md is
-- emphatic that decline emails are never automatic and that acceptances go
-- first; none of that survives a portal that announces the outcome the
-- instant it is recorded.
--
-- WHY A TIMESTAMP RATHER THAN A BOOLEAN. "When were they told" is the question
-- asked when a grantee posts an award before the embargo date, or when an
-- applicant says they never heard. A boolean answers neither.
--
-- WHY IT IS NOT DERIVED FROM email_messages. It nearly could be -- a sent row
-- for the right template against the right application. But a decision can
-- legitimately be communicated by a phone call from the executive director,
-- which is exactly what happens for the largest awards, and a column that
-- cannot record that would push somebody to send a duplicate email to make
-- the portal behave.
--
-- NULLABLE and not backfilled. Applications decided before this migration were
-- decided in a system that had no communication step; inventing a date for
-- them would be worse than admitting it is not recorded.

ALTER TABLE applications ADD COLUMN decision_communicated_at TEXT;

-- How the applicant was told: 'email' when this system sent it, 'manual' when
-- a person recorded that they had done it another way.
ALTER TABLE applications ADD COLUMN decision_communicated_by TEXT
  REFERENCES users(id);
ALTER TABLE applications ADD COLUMN decision_communicated_via TEXT
  CHECK (decision_communicated_via IS NULL
         OR decision_communicated_via IN ('email','manual'));

-- A record of communication always names who recorded it and how. All three
-- together, or none: a date with no method cannot answer the question the
-- column exists for.
CREATE TRIGGER applications_communication_is_complete_insert
BEFORE INSERT ON applications
WHEN (NEW.decision_communicated_at IS NOT NULL) <> (NEW.decision_communicated_via IS NOT NULL)
  OR (NEW.decision_communicated_at IS NOT NULL) <> (NEW.decision_communicated_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a communicated decision records when, by whom, and how');
END;

CREATE TRIGGER applications_communication_is_complete_update
BEFORE UPDATE OF decision_communicated_at, decision_communicated_by,
                 decision_communicated_via ON applications
WHEN (NEW.decision_communicated_at IS NOT NULL) <> (NEW.decision_communicated_via IS NOT NULL)
  OR (NEW.decision_communicated_at IS NOT NULL) <> (NEW.decision_communicated_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a communicated decision records when, by whom, and how');
END;

-- Nothing can be communicated that was not decided. Without this, a stray
-- update could mark an application communicated while its status still reads
-- 'submitted', and the applicant's portal would go quiet for no reason.
CREATE TRIGGER applications_communication_needs_a_decision
BEFORE UPDATE OF decision_communicated_at ON applications
WHEN NEW.decision_communicated_at IS NOT NULL AND NEW.decided_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a decision must be recorded before it can be communicated');
END;

-- "What in this cycle still has to go out." Partial, because after a cycle
-- closes almost every row is communicated and the question is only ever about
-- the ones that are not.
CREATE INDEX applications_awaiting_communication_idx
  ON applications (cycle_id, status)
  WHERE decided_at IS NOT NULL
    AND decision_communicated_at IS NULL
    AND deleted_at IS NULL;
