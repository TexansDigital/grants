-- 0018_retention.sql
--
-- Destroying uploaded financial documents on a schedule.
--
-- THE PROBLEM. A nonprofit applying for a grant hands over its audited
-- financial statements, its full operating budget and an itemized spending
-- budget. Those belong to them, not to the Foundation, and the Foundation's
-- reason for holding them ends when the decision is made. Until now Steward
-- held every one of them forever, because nothing in it could delete anything:
-- "nothing is hard-deleted" is a rule about records, and it had been applied to
-- the bytes as well.
--
-- WHAT IS DESTROYED AND WHAT SURVIVES. The R2 object is destroyed. The
-- `attachments` row survives, with `purged_at` stamped, so the record of what
-- was uploaded, by whom, when, and when it was destroyed remains complete and
-- append-only. That is the distinction non-negotiable #7 is actually about: the
-- record is a financial record, the bytes are a liability. Deleting the row
-- would lose the audit trail; keeping the bytes keeps the exposure.
--
-- WHY THE CLOCK STARTS AT THE DECISION AND NOT AT THE UPLOAD. A cycle can run
-- for months between an early submission and a decision. A clock from upload
-- would destroy an applicant's budget in the middle of the review that needs
-- it, and would punish the organizations who applied first.
--
-- WHY AN AWARD SUSPENDS IT. The itemized budget is what an award is made
-- against and what a grantee's spending is later checked against. Destroying it
-- while the award is live would mean holding a grantee to a document the
-- Foundation threw away. So an application that produced a pending or active
-- award has no due date at all until that award is completed or cancelled.
--
-- WHY THE DUE DATE IS RECOMPUTED NIGHTLY RATHER THAN STAMPED AT DECISION TIME.
-- Decisions get reversed, awards get created after the fact, terms get
-- extended. A stamped date is a snapshot of what was true on one evening; a
-- recomputed one follows the facts, and an admin reading it is reading the
-- current answer rather than an old one.

-- The computed date. NULL means "not due" -- either undecided, or held open by
-- a live award. Only application attachments ever get one; a grantee's report
-- attachment is part of the award record and is out of scope here.
ALTER TABLE attachments ADD COLUMN purge_due_at TEXT;

-- When the bytes were actually destroyed. Once set, the object is gone and the
-- row is a tombstone that still answers "what did they send us, and when did we
-- destroy it".
ALTER TABLE attachments ADD COLUMN purged_at TEXT;

-- An ADMIN OVERRIDE that pushes the date out, with the reason recorded.
--
-- Separate from purge_due_at rather than overwriting it, because purge_due_at
-- is recomputed every night and an override written into it would be silently
-- undone the same evening. The effective date is the later of the two.
ALTER TABLE attachments ADD COLUMN retention_hold_until TEXT;
ALTER TABLE attachments ADD COLUMN retention_reason     TEXT;
ALTER TABLE attachments ADD COLUMN retention_set_by     TEXT REFERENCES users(id);
ALTER TABLE attachments ADD COLUMN retention_set_at     TEXT;

-- The nightly job asks two questions, both of them "which files are due":
-- which to destroy now, and which to warn about. Partial so it covers only
-- rows that have a date and still have bytes -- which, after a few cycles, is
-- a small minority of a table every screen in the system reads.
CREATE INDEX attachments_purge_due_idx
  ON attachments (purge_due_at)
  WHERE purge_due_at IS NOT NULL AND purged_at IS NULL AND deleted_at IS NULL;

-- Two rules the application code must not be the only thing enforcing.

-- A hold with no reason is an extension nobody can account for, on exactly the
-- documents an auditor would ask about.
CREATE TRIGGER attachments_hold_needs_reason_insert
BEFORE INSERT ON attachments
WHEN NEW.retention_hold_until IS NOT NULL
 AND (NEW.retention_reason IS NULL OR TRIM(NEW.retention_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'a retention hold must record a reason');
END;

CREATE TRIGGER attachments_hold_needs_reason_update
BEFORE UPDATE OF retention_hold_until, retention_reason ON attachments
WHEN NEW.retention_hold_until IS NOT NULL
 AND (NEW.retention_reason IS NULL OR TRIM(NEW.retention_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'a retention hold must record a reason');
END;

-- Purging is not reversible and not repeatable. Clearing the stamp would claim
-- bytes exist that were destroyed; moving it would falsify when.
CREATE TRIGGER attachments_purge_is_final
BEFORE UPDATE OF purged_at ON attachments
WHEN OLD.purged_at IS NOT NULL AND NEW.purged_at IS NOT OLD.purged_at
BEGIN
  SELECT RAISE(ABORT, 'a purge cannot be undone or restamped');
END;
