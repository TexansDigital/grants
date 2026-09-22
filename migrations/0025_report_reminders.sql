-- 0025_report_reminders.sql
--
-- Telling a grantee their report is due.
--
-- WHAT WAS WRONG, and it was the largest gap left in Phase 5. The reporting
-- portal is finished: a grantee signs in by magic link, sees what is due, and
-- files it in three clicks. Nothing anywhere told them it existed. The plan put
-- reminders on Eloqua -- correctly, since batch latency does not matter for a
-- nudge -- but Eloqua needs six things from a marketing admin before a single
-- line of it can be written, and until they arrive the portal is a page nobody
-- is sent to. A report nobody is asked for is a report nobody files, and the
-- compliance policy then blocks their next application over silence the
-- Foundation caused.
--
-- So the reminder goes out through Resend, on the transactional domain that
-- already carries the sign-in link. Volume settles this: 100 to 300 grantees a
-- cycle on a ladder of a few sends each is far inside the free tier, and the
-- Eloqua path stays open for when the marketing side is ready to own it.
--
-- WHAT THESE COLUMNS ARE FOR, which is not the sending. Sending is made
-- idempotent by `email_messages`' unique key, as every other send in this
-- system is. These answer the question a program officer asks before picking
-- up the phone: "how many times have we asked, and when was the last one?"
-- Today the compliance desk shows a red row and nothing about whether anybody
-- has been told -- so the honest reading of an overdue report is ambiguous
-- between a nonprofit ignoring us and a nonprofit nobody contacted.

ALTER TABLE report_periods ADD COLUMN reminder_last_sent_at TEXT;
ALTER TABLE report_periods ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(reminder_count) = 'integer' AND reminder_count >= 0);

-- "What is outstanding and has never been chased." Partial, because in a
-- healthy portfolio this is a handful of rows out of every report ever
-- generated, and it is the row an admin most wants to see first.
CREATE INDEX report_periods_unreminded_idx
  ON report_periods (due_date)
  WHERE reminder_last_sent_at IS NULL
    AND status IN ('scheduled', 'open', 'revisions_requested')
    AND deleted_at IS NULL;
