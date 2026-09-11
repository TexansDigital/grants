-- 0012_awards_and_reporting.sql
--
-- Awards, and everything a grantee reports against them.
--
-- WHY THIS COMES BEFORE THE REVIEW PIPELINE, which is not the order CLAUDE.md
-- proposes. The Foundation's first real users are GRANTEES, not applicants:
-- organizations that already hold a grant and currently report on it by email
-- and spreadsheet. That inverts one dependency and it is the reason for the
-- single most important line in this file:
--
--     awards.application_id is NULLABLE.
--
-- Two years of grants were awarded before this platform existed. They have no
-- application row here and never will. An award that required one would make
-- reporting-first impossible, and would quietly assert that this system is the
-- only place a grant can come from -- which is false today and will be false
-- again the first time somebody funds something out of cycle.
--
-- DELIBERATELY NOT IN THIS MIGRATION: payments and award amendments. Reporting
-- does not need either, and both encode decisions still open in CLAUDE.md
-- (payment vocabularies, amendment granularity). A migration cannot be edited
-- once applied, so they land immediately before Phase 4 builds against them.
-- Amendments are additive to this table; nothing here forecloses them.
--
-- Conventions are 0002's and 0006's: TEXT ids, UTC ISO-8601 timestamps, money
-- as integer cents guarded by typeof(), soft-delete, partial unique indexes
-- over live rows, and append-only history enforced by trigger rather than
-- convention.

-- =============================================================================
-- awards
--
-- An award is NOT an application that succeeded. It is its own record, and the
-- two are separate because not every application becomes an award, an award can
-- be amended without rewriting the application it came from, and -- the case
-- that matters today -- an award can exist with no application at all.
--
-- `source_system` and `source_reference` are how an imported grant stays
-- traceable to the row a human can still look up. They are also what makes the
-- importer idempotent: running it twice must not double-award anybody, and the
-- unique index below is what enforces that rather than the importer's own
-- care.
--
-- Renewals and multi-year grants are `parent_award_id` chains, never duplicated
-- records. A second year is a second award that knows its parent.
-- =============================================================================
CREATE TABLE awards (
  id                      TEXT PRIMARY KEY,

  -- NULL for a grant made before this platform, or outside a cycle. See above.
  application_id          TEXT REFERENCES applications(id),
  organization_id         TEXT NOT NULL REFERENCES organizations(id),
  program_id              TEXT NOT NULL REFERENCES programs(id),
  -- Also nullable: a legacy award may predate any cycle row we have.
  cycle_id                TEXT REFERENCES cycles(id),

  -- INTEGER CENTS. The ceiling matches applications: ten billion cents is a
  -- hundred million dollars, four orders of magnitude above anything this
  -- program will award, and still catches a misplaced decimal typed by a human.
  --
  -- WHAT typeof() ACTUALLY BUYS, measured rather than assumed. SQLite applies
  -- INTEGER column affinity BEFORE the CHECK, and only when the conversion is
  -- lossless. So 2500.5 stays REAL and is refused, '2500.5' and 'abc' stay TEXT
  -- and are refused, -1 is refused -- but '2500000' is converted to the integer
  -- 2500000 and accepted. That last case is safe: the value stored is a real
  -- integer. The guard stops a float or an unparseable value reaching a money
  -- column; it is not a type check on what the caller passed.
  awarded_amount_cents    INTEGER NOT NULL
                            CHECK (typeof(awarded_amount_cents) = 'integer'
                                   AND awarded_amount_cents >= 0
                                   AND awarded_amount_cents <= 10000000000),

  awarded_at              TEXT NOT NULL,
  -- Separate from awarded_at on purpose: grantees told on Tuesday post on
  -- Tuesday, so the embargo date is its own fact.
  announcement_date       TEXT,

  -- Collected at ACCEPTANCE, not application. Collecting tax documents from
  -- 300 applicants to fund 50 is waste and unnecessary custody.
  agreement_signed_at     TEXT,
  w9_received_at          TEXT,
  media_release_at        TEXT,

  term_start              TEXT,
  term_end                TEXT,

  is_multi_year           INTEGER NOT NULL DEFAULT 0
                            CHECK (is_multi_year IN (0, 1)),
  parent_award_id         TEXT REFERENCES awards(id),

  --   pending    - decided, not yet accepted by the grantee
  --   active     - accepted, term running, reports expected
  --   completed  - term ended and every obligation met
  --   cancelled  - withdrawn or rescinded. NOT a delete; the row stays.
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','active','completed','cancelled')),

  -- Where an imported award came from, and its id there.
  source_system           TEXT
                            CHECK (source_system IS NULL OR
                                   source_system IN ('formstack','spreadsheet','manual')),
  source_reference        TEXT,

  -- Admin-controlled, for the public grantee list (Module 8). Default private:
  -- publishing another organization's grant is an opt-in, never a default.
  is_public               INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),

  notes                   TEXT,

  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,

  -- A term with an end before its start is a typo, and it drives every report
  -- due date generated from it.
  CHECK (term_start IS NULL OR term_end IS NULL OR term_end >= term_start),
  -- An award is either ours (it has an application) or imported (it says where
  -- it came from). A row that is neither cannot be traced to anything.
  CHECK (application_id IS NOT NULL OR source_system IS NOT NULL),
  -- source_reference without source_system is a dangling id nobody can resolve.
  CHECK (source_reference IS NULL OR source_system IS NOT NULL),
  -- An award cannot be its own parent. Deeper cycles are walked in code with a
  -- depth cap, as merges are.
  CHECK (parent_award_id IS NULL OR parent_award_id <> id)
);

CREATE INDEX awards_organization_idx ON awards (organization_id, status);
CREATE INDEX awards_program_idx ON awards (program_id, awarded_at);
CREATE INDEX awards_parent_idx ON awards (parent_award_id) WHERE parent_award_id IS NOT NULL;

-- Idempotent import. Two runs of the same file produce one award, and this is
-- what guarantees it -- not the importer remembering to check.
CREATE UNIQUE INDEX awards_source_uniq
  ON awards (source_system, source_reference)
  WHERE source_reference IS NOT NULL AND deleted_at IS NULL;

-- One award per application. An application that somehow produced two is a bug
-- worth failing on rather than reconciling later.
CREATE UNIQUE INDEX awards_application_uniq
  ON awards (application_id) WHERE application_id IS NOT NULL AND deleted_at IS NULL;

-- These are financial records. Soft-delete only.
CREATE TRIGGER awards_no_delete
BEFORE DELETE ON awards
BEGIN
  SELECT RAISE(ABORT, 'awards are soft-deleted, never removed');
END;

-- The money on an award is not edited in place. Phase 4 adds award_amendments,
-- and until it exists an amount that needs changing is a conversation, not an
-- UPDATE -- because an overwritten amount leaves no record that it changed.
CREATE TRIGGER awards_amount_is_not_edited_in_place
BEFORE UPDATE OF awarded_amount_cents ON awards
WHEN NEW.awarded_amount_cents <> OLD.awarded_amount_cents
BEGIN
  SELECT RAISE(ABORT, 'an awarded amount changes through an amendment, not an update');
END;

-- =============================================================================
-- metric_definitions
--
-- What a program asks its grantees to count. Per program, because "individuals
-- served" means something different for a food pantry and a literacy program,
-- and the Foundation's own reporting needs them side by side anyway.
--
-- These are rendered INTO a report form as fields. They are not a second form
-- engine: the definition says what to ask and how to aggregate it, the form
-- engine renders it, and the answer is promoted into metric_values so a
-- dashboard is a query rather than a parse.
-- =============================================================================
CREATE TABLE metric_definitions (
  id                TEXT PRIMARY KEY,
  program_id        TEXT NOT NULL REFERENCES programs(id),
  metric_key        TEXT NOT NULL,
  label             TEXT NOT NULL,
  help_text         TEXT,

  --   integer   - a count. Whole people, whole meals.
  --   currency  - integer cents, same rule as everywhere else.
  --   decimal   - a rate or average. Stored in value_number.
  --   text      - a description that cannot be a number, and is not aggregated.
  metric_type       TEXT NOT NULL
                      CHECK (metric_type IN ('integer','currency','decimal','text')),
  -- "meals", "students", "hours". Display only; never parsed.
  unit              TEXT,

  is_required       INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  sort_order        INTEGER NOT NULL DEFAULT 0
                      CHECK (typeof(sort_order) = 'integer'),

  -- Retiring a metric keeps every value already reported against it. A metric
  -- that could be deleted would silently rewrite last year's totals.
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','retired')),

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);

CREATE UNIQUE INDEX metric_definitions_key_uniq
  ON metric_definitions (program_id, metric_key) WHERE deleted_at IS NULL;
CREATE INDEX metric_definitions_program_idx
  ON metric_definitions (program_id, status, sort_order);

CREATE TRIGGER metric_definitions_no_delete
BEFORE DELETE ON metric_definitions
BEGIN
  SELECT RAISE(ABORT, 'metric definitions are retired, never removed');
END;

-- The type decides which column a value lands in and how it aggregates.
-- Changing it under values already reported would restate history.
CREATE TRIGGER metric_definitions_type_is_frozen
BEFORE UPDATE OF metric_type ON metric_definitions
WHEN NEW.metric_type <> OLD.metric_type
  AND EXISTS (SELECT 1 FROM metric_values WHERE metric_definition_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'a metric type cannot change once values have been reported against it');
END;

-- =============================================================================
-- report_periods
--
-- One obligation: this award owes this report by this date.
--
-- `form_definition_id` is PINNED here, not looked up at submission time. A
-- report form edited between a period opening and a grantee filing it would
-- otherwise change the question under an answer already being written -- the
-- same reasoning that freezes a form definition on an application.
--
-- Periods are GENERATED from award terms but are ordinary rows: an admin can
-- add one, move a due date, or waive one, because real grant administration
-- does all three.
-- =============================================================================
CREATE TABLE report_periods (
  id                  TEXT PRIMARY KEY,
  award_id            TEXT NOT NULL REFERENCES awards(id),
  form_definition_id  TEXT REFERENCES form_definitions(id),

  -- "Interim report", "Final report", "Year 2 annual".
  label               TEXT NOT NULL,
  period_type         TEXT NOT NULL
                        CHECK (period_type IN ('interim','final','annual','ad_hoc')),

  -- What the period covers, for the grantee's benefit. Both optional: a final
  -- report on a one-year grant needs no explanation.
  period_start        TEXT,
  period_end          TEXT,

  opens_at            TEXT,
  due_date            TEXT NOT NULL,

  --   scheduled           - exists, not yet open to the grantee
  --   open                - the grantee can file
  --   submitted           - filed, awaiting staff
  --   revisions_requested - sent back with feedback
  --   accepted            - staff are satisfied. Terminal.
  --   waived              - staff decided it is not required. Terminal, and a
  --                         deliberate act with a reason, not a quiet delete.
  status              TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','open','submitted',
                                          'revisions_requested','accepted','waived')),
  waived_reason       TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,

  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  -- Waiving is a decision somebody has to justify.
  CHECK ((status = 'waived') <= (waived_reason IS NOT NULL))
);

CREATE INDEX report_periods_award_idx ON report_periods (award_id, due_date);
-- The compliance view's query: everything due, by date, across the portfolio.
CREATE INDEX report_periods_due_idx
  ON report_periods (status, due_date) WHERE deleted_at IS NULL;

CREATE TRIGGER report_periods_no_delete
BEFORE DELETE ON report_periods
BEGIN
  SELECT RAISE(ABORT, 'report periods are soft-deleted, never removed');
END;

-- Accepted is terminal. Reopening an accepted report would let a submission be
-- replaced after staff signed it off, with the acceptance still on the row.
CREATE TRIGGER report_periods_accepted_is_terminal
BEFORE UPDATE OF status ON report_periods
WHEN OLD.status = 'accepted' AND NEW.status <> 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'an accepted report period cannot be reopened');
END;

-- =============================================================================
-- report_submissions
--
-- What a grantee filed. One row per attempt, never overwritten: a revision is a
-- NEW submission against the same period, so "what did they tell us in March,
-- before we asked for changes" stays answerable.
--
-- `funds_spent_cents` is a promoted column, filled from the answer whose field
-- maps to it -- the same maps_to machinery applications use. It is here rather
-- than only in the answers so that "committed versus disbursed versus spent"
-- is a sum, not a parse.
-- =============================================================================
CREATE TABLE report_submissions (
  id                    TEXT PRIMARY KEY,
  report_period_id      TEXT NOT NULL REFERENCES report_periods(id),
  submitted_by_user_id  TEXT REFERENCES users(id),
  submitted_at          TEXT NOT NULL,

  -- Integer cents. Nullable because not every report asks.
  funds_spent_cents     INTEGER
                          CHECK (funds_spent_cents IS NULL OR
                                 (typeof(funds_spent_cents) = 'integer'
                                  AND funds_spent_cents >= 0
                                  AND funds_spent_cents <= 10000000000)),

  -- Staff side. Feedback is visible to the grantee; it is the one internal
  -- field on this table that is deliberately NOT internal.
  admin_feedback        TEXT,
  accepted_at           TEXT,
  accepted_by           TEXT REFERENCES users(id),

  -- Captured natively, as on applications.
  submission_ip         TEXT,
  submission_user_agent TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,

  CHECK ((accepted_at IS NOT NULL) = (accepted_by IS NOT NULL))
);

CREATE INDEX report_submissions_period_idx
  ON report_submissions (report_period_id, submitted_at);

CREATE TRIGGER report_submissions_no_delete
BEFORE DELETE ON report_submissions
BEGIN
  SELECT RAISE(ABORT, 'report submissions are soft-deleted, never removed');
END;

-- A filed report is the record of what was said. Corrections are a new
-- submission against the same period.
CREATE TRIGGER report_submissions_are_not_rewritten
BEFORE UPDATE OF funds_spent_cents, submitted_at, submitted_by_user_id ON report_submissions
WHEN OLD.funds_spent_cents IS NOT NEW.funds_spent_cents
  OR OLD.submitted_at <> NEW.submitted_at
  OR OLD.submitted_by_user_id IS NOT NEW.submitted_by_user_id
BEGIN
  SELECT RAISE(ABORT, 'a filed report is not rewritten; file a new submission');
END;

-- =============================================================================
-- report_answers
--
-- The report's own answers, mirroring application_answers exactly. Post-award
-- reporting reuses the form engine, so it needs the same place to put an answer
-- and the same four typed columns.
--
-- Separate table rather than a parent_type column on application_answers: that
-- table carries a foreign key to applications and an index built for it, and
-- widening it would make every application query pay for report rows.
-- =============================================================================
CREATE TABLE report_answers (
  id                    TEXT PRIMARY KEY,
  report_submission_id  TEXT NOT NULL REFERENCES report_submissions(id),
  form_field_id         TEXT NOT NULL REFERENCES form_fields(id),

  value_text            TEXT,
  value_int             INTEGER
                          CHECK (value_int IS NULL OR typeof(value_int) = 'integer'),
  value_real            REAL
                          CHECK (value_real IS NULL OR typeof(value_real) = 'real'),
  value_json            TEXT,

  answered_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX report_answers_uniq
  ON report_answers (report_submission_id, form_field_id);

CREATE TRIGGER report_answers_no_delete
BEFORE DELETE ON report_answers
BEGIN
  SELECT RAISE(ABORT, 'report answers are not deleted; blank the value instead');
END;

-- =============================================================================
-- metric_values
--
-- The aggregation surface, and NOT a second source of truth.
--
-- Every row here is promoted from a report answer in the same write. The
-- answer is the record; this is the shape that makes "how many people did this
-- program serve last year" one query instead of a parse over JSON. If the two
-- ever disagree, report_answers is right.
--
-- Typed columns rather than one polymorphic value, for the reason decision §5
-- already settled for answers: SQLite will happily store '1,200' in a column
-- you meant to SUM.
-- =============================================================================
CREATE TABLE metric_values (
  id                    TEXT PRIMARY KEY,
  report_submission_id  TEXT NOT NULL REFERENCES report_submissions(id),
  metric_definition_id  TEXT NOT NULL REFERENCES metric_definitions(id),

  -- integer and currency land here. Currency is CENTS.
  value_int             INTEGER
                          CHECK (value_int IS NULL OR typeof(value_int) = 'integer'),
  -- decimal lands here, and only decimal.
  value_real            REAL
                          CHECK (value_real IS NULL OR typeof(value_real) = 'real'),
  -- text lands here, and is never aggregated.
  value_text            TEXT,

  created_at            TEXT NOT NULL,

  -- Exactly one of the three, or none at all when a grantee left an optional
  -- metric blank. Two populated columns means a promotion bug, and a SUM that
  -- silently counts one of them.
  CHECK (
    (value_int IS NOT NULL) + (value_real IS NOT NULL) + (value_text IS NOT NULL) <= 1
  )
);

CREATE UNIQUE INDEX metric_values_uniq
  ON metric_values (report_submission_id, metric_definition_id);
CREATE INDEX metric_values_definition_idx
  ON metric_values (metric_definition_id);

CREATE TRIGGER metric_values_no_delete
BEFORE DELETE ON metric_values
BEGIN
  SELECT RAISE(ABORT, 'metric values are not deleted; they are the reporting record');
END;
