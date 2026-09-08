-- 0004_applications.sql
--
-- Applications, answers, attachments.
--
-- Stage model (assumption, flagged at build time): a multi-stage program
-- produces ONE APPLICATION ROW PER STAGE, linked by prior_application_id. An
-- LOI and the invited full application are two rows in one chain, not one row
-- that mutates. That keeps each stage's submitted state frozen and auditable,
-- and makes "prefill the full application from the LOI" an explicit copy with
-- an audit row rather than an in-place overwrite of a submitted record.

-- =============================================================================
-- applications
--
-- The columns below the ---- PROMOTED ---- line are written by the maps_to
-- promotion, inside the same atomic batch as the answers they come from. They
-- are a denormalization of application_answers, never an independent source of
-- truth, and they exist so cross-program reporting is a query rather than a
-- parse of an answers table.
-- =============================================================================
CREATE TABLE applications (
  id                        TEXT PRIMARY KEY,
  cycle_id                  TEXT NOT NULL REFERENCES cycles(id),
  stage_id                  TEXT NOT NULL REFERENCES program_stages(id),
  organization_id           TEXT NOT NULL REFERENCES organizations(id),
  -- The exact form version this application was filled against. Pinned so the
  -- application can be rendered faithfully years later.
  form_definition_id        TEXT NOT NULL REFERENCES form_definitions(id),
  -- Prior stage in a multi-stage program (LOI -> full application).
  prior_application_id      TEXT REFERENCES applications(id),
  submitted_by_contact_id   TEXT REFERENCES contacts(id),

  status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                              'draft','submitted','under_review',
                              'declined','awarded','withdrawn'
                            )),

  -- The version of the guidelines document the applicant attested to.
  guidelines_version        TEXT,

  submitted_at              TEXT,
  decided_at                TEXT,
  decided_by                TEXT REFERENCES users(id),

  -- INTERNAL ONLY. Never present in an applicant or grantee response payload.
  -- Not hidden in the UI: absent from the projection. See lib/scope.ts.
  decision_notes            TEXT,
  internal_notes            TEXT,

  submission_ip             TEXT,
  submission_user_agent     TEXT,

  -- ---- PROMOTED from application_answers via form_fields.maps_to ----
  project_title                   TEXT,
  requested_amount_cents          INTEGER
                                    CHECK (requested_amount_cents IS NULL OR
                                           (typeof(requested_amount_cents) = 'integer'
                                            AND requested_amount_cents >= 0)),
  organization_name_at_submit     TEXT,
  ein_at_submit                   TEXT,
  primary_contact_email           TEXT,
  counties_served_json            TEXT,

  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,

  CHECK (counties_served_json IS NULL OR json_valid(counties_served_json)),
  CHECK (ein_at_submit IS NULL OR ein_at_submit GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  CHECK (prior_application_id IS NULL OR prior_application_id <> id),
  -- Anything past draft must carry a submission timestamp.
  CHECK (status = 'draft' OR status = 'withdrawn' OR submitted_at IS NOT NULL),
  -- A decision requires both a timestamp and a decider.
  CHECK ((decided_at IS NULL) = (decided_by IS NULL))
);

CREATE INDEX applications_cycle_status_idx ON applications (cycle_id, status) WHERE deleted_at IS NULL;
CREATE INDEX applications_org_idx          ON applications (organization_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX applications_stage_idx        ON applications (stage_id, status) WHERE deleted_at IS NULL;
CREATE INDEX applications_prior_idx        ON applications (prior_application_id);
CREATE INDEX applications_submitted_idx    ON applications (submitted_at) WHERE deleted_at IS NULL;
-- One application per organization per cycle per stage. Partial so a withdrawn
-- or soft-deleted attempt does not permanently block the organization.
CREATE UNIQUE INDEX applications_org_cycle_stage_uniq
  ON applications (organization_id, cycle_id, stage_id)
  WHERE deleted_at IS NULL AND status <> 'withdrawn';

-- =============================================================================
-- application_answers
--
-- value_int vs value_real is deliberate and load-bearing. A single "value_number"
-- column takes REAL affinity in SQLite, which is exactly how a currency amount
-- silently becomes a float. Currency and integer field types write to value_int
-- ONLY, and the typeof() CHECK makes a float physically unable to land there.
--
-- field_key and label_at_answer are denormalized so an answer remains legible
-- without joining a form_fields row, which may belong to a retired version.
-- =============================================================================
CREATE TABLE application_answers (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id),
  form_field_id     TEXT NOT NULL REFERENCES form_fields(id),

  field_key         TEXT NOT NULL,
  label_at_answer   TEXT NOT NULL,
  field_type        TEXT NOT NULL,

  value_text        TEXT,
  value_int         INTEGER CHECK (value_int IS NULL OR typeof(value_int) = 'integer'),
  value_real        REAL    CHECK (value_real IS NULL OR typeof(value_real) = 'real'),
  value_json        TEXT,

  answered_at       TEXT NOT NULL,

  CHECK (value_json IS NULL OR json_valid(value_json)),
  -- Currency and counts never take a float. This is the last line of defence
  -- for "money is integer cents" and it lives in the database.
  CHECK (field_type NOT IN ('currency','integer') OR value_real IS NULL)
);

CREATE UNIQUE INDEX application_answers_field_uniq
  ON application_answers (application_id, form_field_id);
CREATE INDEX application_answers_app_idx ON application_answers (application_id);
CREATE INDEX application_answers_key_idx ON application_answers (field_key);

-- =============================================================================
-- attachments — R2 object metadata. The file itself NEVER lives in D1.
-- =============================================================================
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  parent_type   TEXT NOT NULL CHECK (parent_type IN (
                  'application','report_submission','award','organization','rubric','program'
                )),
  parent_id     TEXT NOT NULL,
  -- Which form field this upload satisfies, when it came from a form.
  form_field_id TEXT REFERENCES form_fields(id),
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL
                  CHECK (typeof(size_bytes) = 'integer' AND size_bytes >= 0),
  checksum      TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at   TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE UNIQUE INDEX attachments_r2_key_uniq ON attachments (r2_key);
CREATE INDEX attachments_parent_idx ON attachments (parent_type, parent_id) WHERE deleted_at IS NULL;
