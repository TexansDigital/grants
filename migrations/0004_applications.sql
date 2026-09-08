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
  -- Anything past draft must carry a submission timestamp...
  CHECK (status = 'draft' OR status = 'withdrawn' OR submitted_at IS NOT NULL),
  -- ...and a draft must NOT carry one. The original only constrained one
  -- direction, so a row could read 'draft' while claiming it was submitted.
  CHECK (status <> 'draft' OR submitted_at IS NULL),
  -- A decision requires both a timestamp and a decider...
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  -- ...and a decided status requires a decision. Without this, 'awarded' with
  -- no decided_at and no decided_by was accepted: an award nobody made.
  CHECK (status NOT IN ('declined','awarded') OR decided_at IS NOT NULL),
  -- Upper bound mirrors MAX_CENTS in src/lib/money.ts. A typo, not a grant.
  CHECK (requested_amount_cents IS NULL OR requested_amount_cents <= 10000000000)
);

CREATE INDEX applications_cycle_status_idx ON applications (cycle_id, status) WHERE deleted_at IS NULL;
CREATE INDEX applications_org_idx          ON applications (organization_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX applications_stage_idx        ON applications (stage_id, status) WHERE deleted_at IS NULL;
CREATE INDEX applications_prior_idx        ON applications (prior_application_id);
CREATE INDEX applications_submitted_idx    ON applications (submitted_at) WHERE deleted_at IS NULL;
-- One application per organization per cycle per stage. Partial so a withdrawn
-- or soft-deleted attempt does not permanently block the organization.
-- How many live applications one organization may hold per cycle per stage is
-- PROGRAM CONFIGURATION (programs.max_applications_per_cycle), not a universal
-- rule. A fixed unique index made a school district submitting one application
-- per campus, or an arts program accepting three project ideas, impossible.
-- NULL on the program means unlimited.
CREATE TRIGGER applications_respect_per_cycle_limit
BEFORE INSERT ON applications
WHEN (
  SELECT p.max_applications_per_cycle
    FROM programs p JOIN cycles c ON c.program_id = p.id
   WHERE c.id = NEW.cycle_id
) IS NOT NULL
AND (
  SELECT COUNT(*) FROM applications a
   WHERE a.organization_id = NEW.organization_id
     AND a.cycle_id = NEW.cycle_id
     AND a.stage_id = NEW.stage_id
     AND a.deleted_at IS NULL
     AND a.status <> 'withdrawn'
) >= (
  SELECT p.max_applications_per_cycle
    FROM programs p JOIN cycles c ON c.program_id = p.id
   WHERE c.id = NEW.cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'this organization has reached the application limit for this cycle');
END;

-- An application's cycle, stage, and form definition must all belong to ONE
-- program. Foreign keys alone permitted a cycle from program A with a stage and
-- form from program B, which silently scores an applicant against the wrong
-- rubric and reports them under the wrong budget.
CREATE TRIGGER applications_one_program_insert
BEFORE INSERT ON applications
WHEN (SELECT program_id FROM cycles WHERE id = NEW.cycle_id)
     <> (SELECT program_id FROM program_stages WHERE id = NEW.stage_id)
  OR (SELECT program_id FROM cycles WHERE id = NEW.cycle_id)
     <> (SELECT program_id FROM form_definitions WHERE id = NEW.form_definition_id)
BEGIN
  SELECT RAISE(ABORT, 'application cycle, stage, and form definition must belong to the same program');
END;

CREATE TRIGGER applications_one_program_update
BEFORE UPDATE OF cycle_id, stage_id, form_definition_id ON applications
WHEN (SELECT program_id FROM cycles WHERE id = NEW.cycle_id)
     <> (SELECT program_id FROM program_stages WHERE id = NEW.stage_id)
  OR (SELECT program_id FROM cycles WHERE id = NEW.cycle_id)
     <> (SELECT program_id FROM form_definitions WHERE id = NEW.form_definition_id)
BEGIN
  SELECT RAISE(ABORT, 'application cycle, stage, and form definition must belong to the same program');
END;

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
  -- NOTE ON WHAT THIS CHECK DOES AND DOES NOT DO. It rejects a non-integral
  -- float (25000.5). It CANNOT reject the string '2500007': SQLite applies
  -- TEXT -> INTEGER affinity before the CHECK runs, so the string is already an
  -- integer by the time we see it. That case is caught at the binding site by
  -- assertCents() in src/lib/money.ts. The range bound mirrors MAX_CENTS.
  value_int         INTEGER CHECK (value_int IS NULL OR
                                   (typeof(value_int) = 'integer'
                                    AND value_int BETWEEN -10000000000 AND 10000000000)),
  value_real        REAL    CHECK (value_real IS NULL OR typeof(value_real) = 'real'),
  value_json        TEXT,

  answered_at       TEXT NOT NULL,

  CHECK (value_json IS NULL OR json_valid(value_json)),
  -- A money answer lives in value_int and NOWHERE else. Permitting value_text
  -- let '25000.50' be stored as text beside a currency field, which is the
  -- string half of "no floats, no strings, no exceptions".
  CHECK (field_type NOT IN ('currency','integer')
         OR (value_real IS NULL AND value_text IS NULL AND value_json IS NULL))
);

CREATE UNIQUE INDEX application_answers_field_uniq
  ON application_answers (application_id, form_field_id);
CREATE INDEX application_answers_app_idx ON application_answers (application_id);
CREATE INDEX application_answers_key_idx ON application_answers (field_key);

-- An answer must be to a field of the form the application is pinned to.
-- Otherwise an answer can reference a field from an entirely different
-- program's form and render as that field's label years later.
CREATE TRIGGER application_answers_field_belongs_to_form
BEFORE INSERT ON application_answers
WHEN (SELECT form_definition_id FROM form_fields WHERE id = NEW.form_field_id)
     <> (SELECT form_definition_id FROM applications WHERE id = NEW.application_id)
BEGIN
  SELECT RAISE(ABORT, 'answer references a field from a different form definition');
END;

-- =============================================================================
-- attachments — R2 object metadata. The file itself NEVER lives in D1.
-- =============================================================================
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  parent_type   TEXT NOT NULL CHECK (parent_type IN (
                  'application','report_submission','award','organization','rubric','program'
                )),
  -- NULL until the upload is claimed. A file exists from the moment the browser
  -- finishes its presigned PUT, which is before the applicant submits and
  -- therefore before there is a parent to point at. organization_id is what
  -- makes an unclaimed attachment attributable in the meantime.
  parent_id     TEXT,
  -- The owning organization. Present so an attachment reference supplied by a
  -- client can be validated against the session's organization BEFORE it is
  -- accepted into an answer. Without it there is no way to tell that
  -- attachment_id X belongs to somebody else's application.
  organization_id TEXT REFERENCES organizations(id),
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
CREATE INDEX attachments_org_idx ON attachments (organization_id) WHERE deleted_at IS NULL;
