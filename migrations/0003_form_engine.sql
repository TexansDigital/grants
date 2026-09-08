-- 0003_form_engine.sql
--
-- Form definitions are DATA, not code. A new program is rows. Adding a program
-- must never require a migration; that property is what makes this a platform
-- rather than one program's app.
--
-- Two vocabularies that used to be CHECK enums are reference TABLES here
-- (field_types, promotion_targets). A CHECK enum means every new field type or
-- promoted concept is a migration -- which is exactly the thing "a new program
-- is rows, never a migration" exists to prevent. A date picker, a rating scale,
-- or a grantee report metric is now an INSERT.
--
-- Versioning model: a form definition is MUTABLE while status = 'draft' and
-- IMMUTABLE once it has ever been published. Editing a published form means
-- minting a new version. Enforced by triggers, not convention, because an
-- edited label on a 2026 form silently changes the meaning of a 2024
-- application, and these are financial records read years later.

-- =============================================================================
-- field_types -- the field vocabulary, as data.
-- =============================================================================
CREATE TABLE field_types (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  -- Which application_answers column an answer of this type lands in.
  -- 'int' covers currency (integer cents) and counts. Nothing writes 'real'.
  storage     TEXT NOT NULL CHECK (storage IN ('text','int','real','json')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO field_types (key, label, storage) VALUES
  ('short_text',           'Short text',                 'text'),
  ('long_text',            'Long text',                  'text'),
  ('email',                'Email address',              'text'),
  ('phone',                'Phone number',               'text'),
  ('select',               'Single choice',              'text'),
  ('multi_select',         'Multiple choice',            'json'),
  ('checkbox_attestation', 'Attestation checkbox',       'int'),
  ('currency',             'Dollar amount',              'int'),
  ('integer',              'Whole number',               'int'),
  ('url',                  'Web address',                'text'),
  ('address_block',        'Address',                    'json'),
  ('file_upload',          'File upload',                'json'),
  ('consent_checkbox',     'Consent checkbox',           'int'),
  ('other_specify',        'Other, please specify',      'text');

-- =============================================================================
-- promotion_targets -- the maps_to vocabulary, as data.
--
-- A field flagged with a target promotes its answer into a first-class column.
-- target_table/target_column say where. Adding "people served" as a promoted
-- grantee-report metric is a row here, not a migration touching form_fields.
-- =============================================================================
CREATE TABLE promotion_targets (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  target_table   TEXT NOT NULL CHECK (target_table IN ('applications','organizations','contacts')),
  target_column  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO promotion_targets (key, label, target_table, target_column) VALUES
  ('organization_name',             'Organization legal name',   'applications',  'organization_name_at_submit'),
  ('ein',                           'EIN',                       'applications',  'ein_at_submit'),
  ('requested_amount_cents',        'Requested amount',          'applications',  'requested_amount_cents'),
  ('primary_contact_email',         'Primary contact email',     'applications',  'primary_contact_email'),
  ('counties_served',               'Counties or regions served','applications',  'counties_served_json'),
  ('project_title',                 'Project title',             'applications',  'project_title'),
  ('organization_website',          'Organization website',      'organizations', 'website'),
  ('organization_mission',          'Mission statement',         'organizations', 'mission'),
  ('annual_operating_budget_cents', 'Annual operating budget',   'organizations', 'annual_operating_budget_cents'),
  ('contact_first_name',            'Contact first name',        'contacts',      'first_name'),
  ('contact_last_name',             'Contact last name',         'contacts',      'last_name'),
  ('contact_phone',                 'Contact phone',             'contacts',      'phone'),
  ('contact_job_title',             'Contact job title',         'contacts',      'job_title'),
  ('marketing_opt_in',              'Marketing opt-in',          'contacts',      'marketing_opt_in');

-- =============================================================================
-- form_definitions
--
-- form_key identifies a form WITHIN a program, independent of stage. It is what
-- versioning and published-uniqueness key on. This is what lets a program have
-- an interim report form AND a final report form -- keying uniqueness on
-- (program, stage, kind) permitted only one published report per program, and
-- report forms have no stage at all.
-- =============================================================================
CREATE TABLE form_definitions (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES programs(id),
  form_key      TEXT NOT NULL,
  -- NULL for a report form: a report belongs to an award period, not to an
  -- application stage.
  stage_id      TEXT REFERENCES program_stages(id),
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

  CHECK ((status = 'published') <= (published_at IS NOT NULL)),
  -- An application form must belong to a stage; a report form must not.
  CHECK ((kind = 'application') = (stage_id IS NOT NULL))
);

CREATE UNIQUE INDEX form_definitions_version_uniq
  ON form_definitions (program_id, form_key, version) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX form_definitions_published_uniq
  ON form_definitions (program_id, form_key)
  WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX form_definitions_stage_idx ON form_definitions (stage_id);

-- Publication is ONE WAY. The original trigger only blocked published -> draft,
-- which left published -> retired -> draft wide open: retire, edit every label,
-- re-publish, and published_at still reads as the original date so the tampered
-- form is indistinguishable from the one applicants actually filled in.
CREATE TRIGGER form_definitions_publish_is_one_way
BEFORE UPDATE ON form_definitions
WHEN OLD.status <> 'draft' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'a form definition that has been published cannot return to draft: create a new version');
END;

-- published_at is frozen once set. It is the evidence of when the shape an
-- applicant saw became authoritative.
CREATE TRIGGER form_definitions_published_at_frozen
BEFORE UPDATE ON form_definitions
WHEN OLD.published_at IS NOT NULL
 AND (NEW.published_at IS NULL OR NEW.published_at <> OLD.published_at)
BEGIN
  SELECT RAISE(ABORT, 'published_at cannot be changed once set');
END;

CREATE TRIGGER form_definitions_identity_frozen
BEFORE UPDATE ON form_definitions
WHEN OLD.status <> 'draft'
  AND (NEW.program_id IS NOT OLD.program_id
    OR NEW.stage_id   IS NOT OLD.stage_id
    OR NEW.form_key   <> OLD.form_key
    OR NEW.kind       <> OLD.kind
    OR NEW.version    <> OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'a published form definition is immutable: create a new version');
END;

-- A form definition's stage, when it has one, must belong to its own program.
CREATE TRIGGER form_definitions_stage_same_program_insert
BEFORE INSERT ON form_definitions
WHEN NEW.stage_id IS NOT NULL
 AND NEW.program_id <> (SELECT program_id FROM program_stages WHERE id = NEW.stage_id)
BEGIN
  SELECT RAISE(ABORT, 'form definition stage belongs to a different program');
END;

CREATE TRIGGER form_definitions_stage_same_program_update
BEFORE UPDATE ON form_definitions
WHEN NEW.stage_id IS NOT NULL
 AND NEW.program_id <> (SELECT program_id FROM program_stages WHERE id = NEW.stage_id)
BEGIN
  SELECT RAISE(ABORT, 'form definition stage belongs to a different program');
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
-- express a unique index across a join. Triggers keep it consistent on INSERT
-- and on UPDATE.
--
-- translations_json is reserved for field-level Spanish. English only today.
-- The column exists so adding it later is content entry, not a migration that
-- touches every field row in the system.
-- =============================================================================
CREATE TABLE form_fields (
  id                      TEXT PRIMARY KEY,
  form_definition_id      TEXT NOT NULL REFERENCES form_definitions(id),
  form_section_id         TEXT NOT NULL REFERENCES form_sections(id),
  field_key               TEXT NOT NULL,
  label                   TEXT NOT NULL,
  help_text               TEXT,
  field_type              TEXT NOT NULL REFERENCES field_types(key),
  is_required             INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0,1)),
  sort_order              INTEGER NOT NULL DEFAULT 0,
  options_json            TEXT,
  validation_json         TEXT,
  conditional_on_field_id TEXT REFERENCES form_fields(id),
  conditional_value       TEXT,
  maps_to                 TEXT REFERENCES promotion_targets(key),
  translations_json       TEXT,
  created_at              TEXT NOT NULL,

  CHECK (options_json IS NULL OR json_valid(options_json)),
  CHECK (validation_json IS NULL OR json_valid(validation_json)),
  CHECK (translations_json IS NULL OR json_valid(translations_json)),
  CHECK (conditional_on_field_id IS NULL OR conditional_on_field_id <> id),
  CHECK ((conditional_on_field_id IS NULL) = (conditional_value IS NULL))
);

CREATE UNIQUE INDEX form_fields_key_uniq
  ON form_fields (form_definition_id, field_key);
CREATE UNIQUE INDEX form_fields_maps_to_uniq
  ON form_fields (form_definition_id, maps_to) WHERE maps_to IS NOT NULL;
CREATE INDEX form_fields_section_idx
  ON form_fields (form_section_id, sort_order);

-- Keep the denormalized definition id honest, on INSERT and on UPDATE.
CREATE TRIGGER form_fields_definition_matches_section_insert
BEFORE INSERT ON form_fields
WHEN NEW.form_definition_id <>
     (SELECT form_definition_id FROM form_sections WHERE id = NEW.form_section_id)
BEGIN
  SELECT RAISE(ABORT, 'form_fields.form_definition_id must match its section');
END;

CREATE TRIGGER form_fields_definition_matches_section_update
BEFORE UPDATE ON form_fields
WHEN NEW.form_definition_id <>
     (SELECT form_definition_id FROM form_sections WHERE id = NEW.form_section_id)
BEGIN
  SELECT RAISE(ABORT, 'form_fields.form_definition_id must match its section');
END;

-- -----------------------------------------------------------------------------
-- Immutability of a published definition's shape.
--
-- Each UPDATE guard checks BOTH sides. Checking only OLD let a row be moved
-- OUT of a draft definition and INTO a published one, which smuggles a field
-- into a form applicants had already submitted against.
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
  OR (SELECT status FROM form_definitions WHERE id = NEW.form_definition_id) <> 'draft'
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
  OR (SELECT status FROM form_definitions WHERE id = NEW.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;

CREATE TRIGGER form_fields_no_delete_after_publish
BEFORE DELETE ON form_fields
WHEN (SELECT status FROM form_definitions WHERE id = OLD.form_definition_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'form definition is published: create a new version to change it');
END;
