-- 0002_core_entities.sql
--
-- Programs, stages, cycles, organizations, contacts, users.
--
-- Conventions used throughout this schema:
--   * ids are TEXT (UUIDv4), generated in the Worker
--   * timestamps are TEXT, ISO-8601, ALWAYS UTC. Central time is a display
--     concern, applied at the edge. Never store a local time.
--   * money is INTEGER cents, guarded by typeof() CHECK constraints so a float
--     cannot enter the database even if application code is wrong
--   * nothing is hard-deleted: deleted_at IS NULL means live
--   * uniqueness is expressed as a PARTIAL unique index over live rows, because
--     a plain UNIQUE constraint would collide with soft-deleted and merged rows

-- =============================================================================
-- programs
-- =============================================================================
CREATE TABLE programs (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','active','archived')),
  fiscal_year           INTEGER,
  total_budget_cents    INTEGER
                          CHECK (total_budget_cents IS NULL OR
                                 (typeof(total_budget_cents) = 'integer' AND total_budget_cents >= 0)),
  -- What an overdue grantee report does to a NEW application from that org.
  compliance_policy     TEXT NOT NULL DEFAULT 'warn'
                          CHECK (compliance_policy IN ('block','warn','ignore')),
  guidelines_doc_id     TEXT,
  guidelines_version    TEXT,
  -- Which promotion targets a form in THIS program must collect before it can
  -- be published. A JSON array of promotion_targets keys. Per-program rather
  -- than a global constant because not every program has an applicant
  -- organization: a scholarship or an individual coaches' grant legitimately
  -- has no EIN and no organization legal name to collect.
  required_maps_to_json TEXT NOT NULL
                          DEFAULT '["organization_name","ein","requested_amount_cents","primary_contact_email","counties_served"]',
  -- How many live applications one organization may have per cycle per stage.
  -- 1 is the common case. A district submitting one application per campus, or
  -- an arts program accepting three project ideas, sets this higher.
  -- NULL means unlimited.
  max_applications_per_cycle INTEGER
                          DEFAULT 1
                          CHECK (max_applications_per_cycle IS NULL OR
                                 (typeof(max_applications_per_cycle) = 'integer'
                                  AND max_applications_per_cycle >= 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,

  CHECK (json_valid(required_maps_to_json))
);

CREATE UNIQUE INDEX programs_slug_uniq ON programs (slug) WHERE deleted_at IS NULL;
CREATE INDEX programs_status_idx ON programs (status) WHERE deleted_at IS NULL;

-- =============================================================================
-- program_stages
--
-- A program is one stage (single application), two stages (eligibility screen
-- then full application), or two stages with a gate (LOI then INVITED full
-- application). gate_on_prior_decision = 1 means an applicant may not begin
-- this stage until a decision exists on the prior stage.
-- =============================================================================
CREATE TABLE program_stages (
  id                        TEXT PRIMARY KEY,
  program_id                TEXT NOT NULL REFERENCES programs(id),
  stage_key                 TEXT NOT NULL,
  name                      TEXT NOT NULL,
  sort_order                INTEGER NOT NULL DEFAULT 0,
  gate_on_prior_decision    INTEGER NOT NULL DEFAULT 0
                              CHECK (gate_on_prior_decision IN (0,1)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT
);

CREATE UNIQUE INDEX program_stages_key_uniq
  ON program_stages (program_id, stage_key) WHERE deleted_at IS NULL;
CREATE INDEX program_stages_program_idx ON program_stages (program_id, sort_order);

-- =============================================================================
-- cycles
--
-- opens_at / closes_at are UTC. draft_grace_hours is open decision #6 made
-- explicit and per-cycle rather than left implicit: how long after closes_at a
-- draft STARTED before close may still be submitted. 0 = hard cutoff.
-- =============================================================================
CREATE TABLE cycles (
  id                  TEXT PRIMARY KEY,
  program_id          TEXT NOT NULL REFERENCES programs(id),
  name                TEXT NOT NULL,
  opens_at            TEXT NOT NULL,
  closes_at           TEXT NOT NULL,
  decision_due_at     TEXT,
  announcement_date   TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','open','closed','decided','archived')),
  rubric_id           TEXT,
  draft_grace_hours   INTEGER NOT NULL DEFAULT 0
                        CHECK (typeof(draft_grace_hours) = 'integer' AND draft_grace_hours >= 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,

  CHECK (closes_at > opens_at)
);

CREATE INDEX cycles_program_idx ON cycles (program_id, status);
CREATE INDEX cycles_open_idx ON cycles (status, closes_at) WHERE deleted_at IS NULL;

-- =============================================================================
-- organizations — the applicant/grantee nonprofit. This is the tenant boundary
-- for every external user. organization_id on a session scopes all their reads.
--
-- ein is stored NORMALIZED: exactly 9 digits, no dash. Display formatting is a
-- display concern. There is deliberately NO unique index on ein: duplicates are
-- inevitable (same nonprofit, two contacts, dash one year and not the next) and
-- an insert failure mid-application is a terrible applicant experience. We match
-- on EIN at submit, flag the candidate, and let an admin merge.
-- =============================================================================
CREATE TABLE organizations (
  id                              TEXT PRIMARY KEY,
  legal_name                      TEXT NOT NULL,
  dba_name                        TEXT,
  ein                             TEXT,
  ein_verified_at                 TEXT,
  -- The legal name the IRS file returned, so we can show it back to the
  -- applicant rather than making them prove anything.
  ein_verified_name               TEXT,
  website                         TEXT,
  address_json                    TEXT,
  mission                         TEXT,
  annual_operating_budget_cents   INTEGER
                                    CHECK (annual_operating_budget_cents IS NULL OR
                                           (typeof(annual_operating_budget_cents) = 'integer'
                                            AND annual_operating_budget_cents >= 0)),
  status                          TEXT NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active','merged','inactive')),
  merged_into_id                  TEXT REFERENCES organizations(id),
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL,
  deleted_at                      TEXT,

  CHECK (ein IS NULL OR ein GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (address_json IS NULL OR json_valid(address_json)),
  -- A merged organization must point somewhere, and a live one must not.
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);

CREATE INDEX organizations_ein_idx  ON organizations (ein) WHERE deleted_at IS NULL;
CREATE INDEX organizations_name_idx ON organizations (legal_name) WHERE deleted_at IS NULL;
CREATE INDEX organizations_merge_idx ON organizations (merged_into_id);

-- A merge must point at a LIVE, unmerged organization. Without this, A can be
-- merged into B while B is merged into A, and any "walk to the surviving
-- organization" loop hangs. Merging into a soft-deleted row is equally broken.
-- Soft-deleting an organization that still has live applications or live users
-- leaves orphans that every scoped query would have to remember to filter.
-- Refusing the delete is one rule in one place; filtering the parent in every
-- future query is a rule that will eventually be forgotten.
CREATE TRIGGER organizations_no_soft_delete_with_live_records
BEFORE UPDATE OF deleted_at ON organizations
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
 AND (
   EXISTS (SELECT 1 FROM applications WHERE organization_id = OLD.id AND deleted_at IS NULL)
   OR EXISTS (SELECT 1 FROM users WHERE organization_id = OLD.id AND deleted_at IS NULL)
 )
BEGIN
  SELECT RAISE(ABORT, 'cannot delete an organization that still has live applications or users');
END;

CREATE TRIGGER organizations_merge_target_must_be_live
BEFORE UPDATE OF merged_into_id, status ON organizations
WHEN NEW.merged_into_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM organizations t
    WHERE t.id = NEW.merged_into_id
      AND t.deleted_at IS NULL
      AND t.status <> 'merged'
 )
BEGIN
  SELECT RAISE(ABORT, 'an organization can only be merged into a live, unmerged organization');
END;

-- =============================================================================
-- contacts — people at an organization. Not all of them can log in.
-- marketing_opt_in is the ONLY field that ever syncs to Eloqua.
-- =============================================================================
CREATE TABLE contacts (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  salutation          TEXT,
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT NOT NULL,
  phone               TEXT,
  job_title           TEXT,
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  can_login           INTEGER NOT NULL DEFAULT 1 CHECK (can_login IN (0,1)),
  marketing_opt_in    INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0,1)),
  marketing_synced_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,

  CHECK (email = lower(email))
);

CREATE UNIQUE INDEX contacts_org_email_uniq
  ON contacts (organization_id, email) WHERE deleted_at IS NULL;
CREATE INDEX contacts_email_idx ON contacts (email) WHERE deleted_at IS NULL;
CREATE INDEX contacts_org_idx ON contacts (organization_id) WHERE deleted_at IS NULL;

-- =============================================================================
-- users
--
-- The CHECK below is a structural expression of the access-control model:
-- external roles MUST carry an organization_id (it is what scopes every query
-- they make), internal roles MUST NOT (they are not bound to one nonprofit).
-- Getting this wrong is the failure mode that leaks one nonprofit's audited
-- financials to another, so it is enforced by the database, not by a code path.
-- =============================================================================
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL
                      CHECK (role IN ('admin','reviewer','applicant','grantee','executive')),
  organization_id   TEXT REFERENCES organizations(id),
  display_name      TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,

  CHECK (email = lower(email)),
  CHECK (
    (role IN ('applicant','grantee') AND organization_id IS NOT NULL)
    OR
    (role IN ('admin','reviewer','executive') AND organization_id IS NULL)
  )
);

CREATE UNIQUE INDEX users_email_uniq ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_org_idx ON users (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;
