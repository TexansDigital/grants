-- What a grant was actually for.
--
-- THE PROBLEM THIS SOLVES, stated plainly: the compliance desk, the grants
-- list and the search box can tell you that the Foundation gave Houston Food
-- Bank $50,000 in 2025. Nothing in this database can tell you what for. Ask
-- "have we ever funded youth mental health in Fort Bend County" -- the
-- question 0005_search.sql opens by quoting -- and the answer for every grant
-- currently held is no rows, because there is nothing to match against.
--
-- WHY THE EXISTING SEARCH INDEX DOES NOT COVER IT. `application_fts` indexes
-- one document per APPLICATION, with columns for counties, focus area and
-- narrative. That is the right shape, and it is unreachable for the grants
-- that exist: awards.application_id is NULL for anything imported (0012 says
-- so in as many words), and the award importer accepts identity and dates --
-- ein, amount, term_start, status, notes -- and nothing describing the work.
-- Thirteen grants went in that way. None of them has a row in that index, and
-- none ever will.
--
-- WHY THESE LIVE ON THE AWARD AND NOT ONLY ON THE APPLICATION. Applications
-- and awards are separate records on purpose: what was asked for and what was
-- funded are different facts, and a grant made at half the request is usually
-- a narrower piece of work. The award's columns are the record of what the
-- FOUNDATION funded, which is what a later reader is asking about. Where an
-- award does come from an application, these are seeded from it and then stand
-- on their own.
--
-- WHY THE NAMES MATCH `applications`. `project_title` and
-- `counties_served_json` are spelled exactly as 0004 spells them, with the
-- same json_valid CHECK, so one reporting query can read both tables without a
-- translation layer. `focus_area` is a plain column here because an award has
-- no answers to derive one from -- on an application it is assembled from
-- field keys at index time (src/lib/search.ts, FOCUS_AREA_KEYS).
--
-- NOT HARD-CODED TO ANY PROGRAM. There is no county list and no focus-area
-- enumeration in this schema. Inspire Change's counties live in the
-- options_json of its own form definition, where a second program's different
-- list will live too. These columns hold whatever a program's vocabulary is.
--
-- ALL NULLABLE. Blank is the normal state: a grant recorded before anyone got
-- round to cataloguing it is not an error, and every screen renders the
-- absence without a dangling label.

ALTER TABLE awards ADD COLUMN project_title TEXT;

-- A sentence or two: what the money paid for. Distinct from `notes`, which is
-- operational ("cheque reissued 3 March") and is not about the work.
ALTER TABLE awards ADD COLUMN purpose TEXT;

ALTER TABLE awards ADD COLUMN focus_area TEXT;

-- A JSON array of place names, as on applications. The CHECK is the same one
-- 0004 puts on the application column; NULL passes, which is what we want.
ALTER TABLE awards ADD COLUMN counties_served_json TEXT
  CHECK (counties_served_json IS NULL OR json_valid(counties_served_json));
