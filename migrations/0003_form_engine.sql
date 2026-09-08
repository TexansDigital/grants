-- 0003_form_engine.sql
--
-- Form definitions are DATA, not code. A new program is rows. Adding a program
-- must never require a migration; that property is what makes this a platform
-- rather than one program's app, and it is verified by a test.
--
-- Versioning model (assumption, flagged at build time):
--   A form definition is MUTABLE while status = 'draft' and IMMUTABLE once
--   status = 'published'. Editing a published form means minting a new version.
--   This is enforced by triggers, not by convention, because an edited label on
--   a 2026 form silently changes the meaning of a 2024 application, and these
--   are financial records that get read years later.

-- =============================================================================
-- form_definitions — one per (program, stage, version)
-- =============================================================================
CREATE TABLE form_definitions (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES programs(id),
  stage_id      TEXT NOT NULL REFERENCES program_stages(id),
  -- 'application' or 'report'. Post-award reporting reuses this whole engine;
  -- a report form is a form definition with metric fields appended.
  kind          TEXT NOT NULL DEFAULT 'application'
                  CHECK (kind IN ('application','report')),
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','retired')),
  published_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,

  CHECK ((status = 'published') <= (published_at IS NOT NULL))
);

CREATE UNIQUE INDEX form_definitions_version_uniq
  ON form_definitions (program_id, stage_id, kind, version) WHERE deleted_at IS NULL;
-- At most one published definition per (program, stage, kind) at a time.
CREATE UNIQUE INDEX form_definitions_published_uniq
  ON form_definitions (program_id, stage_id, kind)
  WHERE status = 'published' AND deleted_at IS NULL;

-- A published definition may only move to 'retired'. It can never go back to
-- draft, and its identity columns are frozen.
CREATE TRIGGER form_definitions_publish_is_one_way
BEFORE UPDATE ON form_definitions
WHEN OLD.status = 'published' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'a published form definition cannot return to draft: create a new version');
END;

CREATE TRIGGER form_definitions_identity_frozen
BEFORE UPDATE ON form_definitions
WHEN OLD.status <> 'draft'
  AND (NEW.program_id <> OLD.program_id
    OR NEW.stage_id   <> OLD.stage_id
    OR NEW.kind       <> OLD.kind
    OR NEW.version    <> OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'a published form definition is immutable: create a new version');
END;

-- =============================================================================
-- form_sections
-- =============================================================================
CREATE TABLE form_sections (
  id                    TEXT PRIMARY KEY,
  form_definition_id    TEXT NOT NULL REFERENCES form_definitions(id),
  section_key           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX form_sections_key_uniq
  ON form_sections (form_definition_id, section_key);
CREATE INDEX form_sections_def_idx
  ON form_sections (form_definition_id, sort_order);

-- =============================================================================
-- form_fields
--
-- form_definition_id is denormalized from the section on purpose: field_key and
-- maps_to must be unique per DEFINITION, not per section, and SQLite cannot
-- express a unique index across a join. A trigger keeps it consistent.
--
-- maps_to is mandatory infrastructure. A field flagged maps_to promotes its
-- answer into a first-class column on applications. Without it, cross-program
-- reporting means parsing an answers table forever.
--
-- translations_json is reserved for field-level Spanish. English only today.
-- The column exists so that adding it later is content entry, not a migration
-- that touches every field row in the system.
-- =============================================================================
CREATE TABLE form_fields (
  id                      TEXT PRIMARY KEY,
  form_definition_id      TEXT NOT NULL REFERENCES form_definitions(id),
  form_section_id         TEXT NOT NULL REFERENCES form_sections(id),
  field_key               TEXT NOT NULL,
  label                   TEXT NOT NULL,
  help_text               TEXT,
  field_type              TEXT NOT NULL CHECK (field_type IN (
                            'short_text',
                            'long_text',
                            'email',
                            'phone',
                            'select',
                            'multi_select',
                            'checkbox_attestation',
                            'currency',
                            'integer',
                            'url',
                            'address_block',
                            'file_upload',
                            'consent_checkbox',
                            'other_specify'
                          )),
  is_required             INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0,1)),
  sort_order              INTEGER NOT NULL DEFAULT 0,
  options_json            TEXT,
  validation_json         TEXT,
  conditional_on_field_id TEXT REFERENCES form_fields(id),
  conditional_value       TEXT,
  maps_to                 TEXT CHECK (maps_to IS NULL OR maps_to IN (
                            'organization_name',
                            'ein',
                            'requested_amount_cents',
                            'primary_contact_email',
                            'counties_served',
                            'project_title',
                            'organization_website',
                            'organization_mission',
                            'annual_operating_budget_cents',
                            'contact_first_name',
                            'contact_last_name',
                            'contact_phone',
                            'contact_job_title',
                            'marketing_opt_in'
                          )),
  translations_json       TEXT,
  created_at              TEXT NOT NULL,

  CHECK (options_json IS NULL OR json_valid(options_json)),
  CHECK (validation_json IS NULL OR json_valid(validation_json)),
  CHECK (translations_json IS NULL OR json_valid(translations_json)),
  CHECK (conditional_on_field_id IS NULL OR conditional_on_field_id <> id),
  -- A conditional field must say what value reveals it.
  CHECK ((conditional_on_field_id IS NULL) = (conditional_value IS NULL))
);

CREATE UNIQUE INDEX form_fields_key_uniq
  ON form_fields (form_definition_id, field_key);
-- Two fields in one definition can never claim the same promotion target.
CREATE UNIQUE INDEX form_fields_maps_to_uniq
  ON form_fields (form_definition_id, maps_to) WHERE maps_to IS NOT NULL;
CREATE INDEX form_fields_section_idx
  ON form_fields (form_section_id, sort_order);

-- Keep the denormalized definition id honest.
CREATE TRIGGER form_fields_definition_matches_section
BEFORE INSERT ON form_fields
WHEN NEW.form_definition_id <>
     (SELECT form_definition_id FROM form_sections WHERE id = NEW.form_section_id)
BEGIN
  SELECT RAISE(ABORT, 'form_fields.form_definition_id must match its section');
END;

-- -----------------------------------------------------------------------------
-- Immutability of a published definition's shape.
-- -----------------------------------------------------------------------------
CREATE TRIGGER form_sections_no_insert_after_publish
BEFORE INSERT ON form_sections
WHEN (SELECT status FROM form_definitions WHERE id = NEW.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_sections_no_update_after_publish
BEFORE UPDATE ON form_sections
WHEN (SELECT status FROM form_definitions WHERE id = OLD.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_sections_no_delete_after_publish
BEFORE DELETE ON form_sections
WHEN (SELECT status FROM form_definitions WHERE id = OLD.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_fields_no_insert_after_publish
BEFORE INSERT ON form_fields
WHEN (SELECT status FROM form_definitions WHERE id = NEW.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_fields_no_update_after_publish
BEFORE UPDATE ON form_fields
WHEN (SELECT status FROM form_definitions WHERE id = OLD.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_fields_no_delete_after_publish
BEFORE DELETE ON form_fields
WHEN (SELECT status FROM form_definitions WHERE id = OLD.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;
