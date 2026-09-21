-- 0017_attachment_downloads.sql
--
-- When a file was last fetched, and how often.
--
-- THE GAP THIS FILLS. Until now nothing in this system could open an uploaded
-- file. Applicants could upload audited financial statements and operating
-- budgets, the bytes landed in R2, the metadata landed in `attachments` -- and
-- there was no path by which a reviewer or an admin could read one. The audit
-- log has carried an `attachment.download_url_issued` action since Phase 0
-- and no code has ever written that row. A review process that cannot open the
-- budget is not a review process.
--
-- WHY THE COLUMNS ARE NAMED "download_url_issued" AND NOT "downloaded".
-- Uploads and downloads both go straight between the browser and R2; the
-- Worker only signs. That is the pattern CLAUDE.md fixes and it is the right
-- one, but it means this system genuinely does not know whether the bytes were
-- ever fetched. It knows it handed out a credential to fetch them.
--
-- The distinction is not pedantry, because retention is about to be built on
-- top of these columns and will stop warning an admin once one is set. Calling
-- the column `downloaded_at` would make that read "we stopped warning because
-- they have a copy", when what is true is "we stopped warning because they
-- asked for one". Somebody deciding whether it is safe to destroy a financial
-- statement should be told which of those two things happened.
--
-- The honest alternative -- proxying the bytes through the Worker so a real
-- download could be observed -- is ruled out by the same rule that shaped the
-- upload path: the edge request body limit rejects large transfers before any
-- handler runs, and a download path that fails on exactly the biggest files is
-- worse than one that is candid about what it measures.

ALTER TABLE attachments ADD COLUMN download_url_first_issued_at TEXT;
ALTER TABLE attachments ADD COLUMN download_url_last_issued_at  TEXT;

-- NOT NULL with a default, which SQLite permits on ADD COLUMN precisely
-- because every existing row can be given the value without ambiguity: no file
-- has ever had a download URL issued for it, so zero is a fact about them
-- rather than a placeholder.
ALTER TABLE attachments ADD COLUMN download_url_issue_count INTEGER NOT NULL DEFAULT 0;
