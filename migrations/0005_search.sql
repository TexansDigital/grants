-- 0005_search.sql
--
-- Full-text search over application narrative and organization fields, so
-- "have we ever funded youth mental health in Fort Bend County" is a query
-- rather than an afternoon.
--
-- DESIGN NOTE — why this is an aggregate table and not an external-content FTS
-- index over application_answers:
--
--   1. Narrative lives one-row-per-field in application_answers. An index over
--      those rows matches fragments and ranks them badly. The useful unit of
--      search is the APPLICATION, so we index one document per application.
--
--   2. Autosave writes an answer row every few seconds while an applicant is
--      typing. Trigger-driven FTS maintenance would rebuild the index
--      continuously for drafts that nobody searches. Instead the index is
--      populated explicitly at submit and on admin edit. Drafts are not
--      searchable, which is the correct behaviour anyway: staff search
--      submitted work.
--
-- Duplication cost is irrelevant at hundreds of applications a year.

CREATE VIRTUAL TABLE application_fts USING fts5(
  application_id UNINDEXED,
  organization_name,
  ein,
  project_title,
  counties,
  focus_area,
  narrative,
  tokenize = 'porter unicode61'
);

-- Bookkeeping for the aggregate: when each application was last indexed, so a
-- reindex sweep can find stale rows without touching the virtual table.
CREATE TABLE application_search_state (
  application_id  TEXT PRIMARY KEY REFERENCES applications(id),
  indexed_at      TEXT NOT NULL,
  -- Hash of the source document; lets a reindex skip unchanged applications.
  content_hash    TEXT NOT NULL
);

CREATE INDEX application_search_state_indexed_idx
  ON application_search_state (indexed_at);
