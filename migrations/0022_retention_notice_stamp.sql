-- 0022_retention_notice_stamp.sql
--
-- Remembering which files have already been warned about.
--
-- WHAT WAS WRONG. The month-out heads-up fired from arithmetic on the run's
-- own clock: a file got its first notice only if its deletion date fell in the
-- one-day-wide slice between 29 and 30 days from the instant the cron happened
-- to execute. That window is contiguous only if the job runs every night at
-- exactly the same moment. A night the cron is missed, a retry that lands an
-- hour late, an admin releasing a hold that moves a date into the middle of
-- the window -- each silently skips the heads-up for whichever files fall in
-- the gap, and nothing anywhere records that it was skipped.
--
-- The daily notices in the last week are cumulative and were never affected;
-- what was lost was the one warning that arrives while there is still a month
-- to act on it.
--
-- WHAT THIS CHANGES IT TO. A file gets its heads-up the first night it is seen
-- inside the horizon and has never been named in a notice. That is a fact
-- about the file rather than about when the job ran, so a missed night delays
-- the warning by a night instead of losing it.
--
-- NOT AN IDEMPOTENCY KEY. Per-admin, per-day delivery is already unique by the
-- messages index; this is the file's own record of having been mentioned.

ALTER TABLE attachments ADD COLUMN retention_notice_sent_at TEXT;

-- "Which files inside the horizon have never been warned about." Partial,
-- because the answer is almost always a handful and the table is every upload
-- the system has ever taken.
CREATE INDEX attachments_retention_unnoticed_idx
  ON attachments (purge_due_at)
  WHERE retention_notice_sent_at IS NULL
    AND purge_due_at IS NOT NULL
    AND purged_at IS NULL
    AND deleted_at IS NULL;
