-- 0016_junk_reason.sql
--
-- Why a row was put away.
--
-- THE DECISION THIS SERVES. Registration is open: anybody may fill in the
-- eligibility screen and become an organization in this system, and the
-- Foundation clears out the fake ones afterwards. That is a normal way to run
-- intake -- the alternative is a validation list that does not exist -- but it
-- means junk accumulates in the pipeline, in the duplicate-candidate list and
-- in every count on a dashboard, and until now nothing could remove it.
--
-- NOTHING IS HARD-DELETED, so "remove" means `deleted_at`, which both tables
-- already carry. What was missing is the reason.
--
-- WHY A COLUMN RATHER THAN READING IT BACK OUT OF THE AUDIT LOG. The audit row
-- has it, and the audit log is the record of record. But the screen that lists
-- what was put away -- so somebody can undo a mistake -- would then need a
-- correlated lookup of the most recent matching audit row per organization,
-- on a table that grows forever and is indexed for a different question. The
-- reason on the row is a copy, and the audit row remains the truth.
--
-- NOT CALLED junk_reason. Soft-delete has other uses: a duplicate resolved by
-- hand, a test organization from a dry run, an applicant who asked to be
-- removed. Naming the column after one of them would make the others look
-- wrong.
--
-- NULLABLE, because every row soft-deleted before this migration was deleted
-- without a reason being recorded, and inventing one for them would be worse
-- than admitting it is not known.

ALTER TABLE organizations ADD COLUMN deleted_reason TEXT;
ALTER TABLE applications  ADD COLUMN deleted_reason TEXT;

-- The review screen reads "what has been put away, most recent first". Partial
-- so it indexes only the rows that screen is about, which are a small minority
-- of a table the rest of the system reads constantly.
CREATE INDEX organizations_deleted_idx
  ON organizations (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX applications_deleted_idx
  ON applications (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
