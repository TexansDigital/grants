-- 0013_report_forms.sql
--
-- What a report form is made of.
--
-- 0012 gave a program `metric_definitions` -- what it asks its grantees to
-- count -- and said, in the comment on that table, that they are "rendered INTO
-- a report form as fields" and "not a second form engine". This migration is
-- the wiring that makes that sentence true, and it is three small things:
--
--   1. A field can say which metric it reports.       form_fields.metric_definition_id
--   2. A metric can say it is the funds-spent one.    metric_definitions.promotes_to
--   3. A decimal field type, because metric_type      field_types row
--      'decimal' had no field that could collect it.
--
-- WHY NOT maps_to. The obvious move was to reuse `maps_to`, which is how an
-- application field promotes into a column. It does not fit, twice over. A
-- maps_to target is a fixed vocabulary row in `promotion_targets`, and metrics
-- are per program and created by admins -- a new metric would mean a new row in
-- a vocabulary table shared by every program, keyed globally, colliding the
-- moment two programs both count "individuals served" and mean different
-- things. And `promotion_targets.target_table` is CHECKed to three tables, none
-- of which is report_submissions, so widening it means rebuilding a table that
-- form_fields holds a foreign key into. A direct reference to the metric row is
-- both narrower and more honest: this field reports THAT metric, for THAT
-- program.
--
-- funds_spent_cents is the one exception, and it is declared on the METRIC
-- rather than on the field. 0012 promised report_submissions.funds_spent_cents
-- would be "filled from the answer whose field maps to it". It is: from the
-- answer whose field reports the metric that claims it. One claim per program,
-- enforced by index, and only a currency metric may claim it.

-- =============================================================================
-- 1. The decimal field type.
--
-- metric_type 'decimal' has been a legal metric since 0012 and there has been
-- no field type that could collect one: 0003 shipped fourteen types and its own
-- comment noted "nothing writes 'real'". A rate, an average, or volunteer hours
-- to one decimal place is a normal thing for a funder to ask, and rounding it
-- into an integer at intake is a data loss nobody consented to.
--
-- This is an INSERT rather than a migration to a CHECK constraint precisely
-- because 0003 made the field vocabulary a table. The renderer and the
-- validator are still code -- see coerceAnswer -- but the vocabulary is data,
-- as intended.
-- =============================================================================
INSERT INTO field_types (key, label, storage) VALUES
  ('decimal', 'Decimal number', 'real');

-- =============================================================================
-- 2. metric_definitions.promotes_to
--
-- Nullable, and almost always null. A program names ONE currency metric as the
-- one that answers "how much of the grant has been spent", and that answer is
-- promoted onto report_submissions so that "committed versus disbursed versus
-- spent" stays a SUM rather than a parse.
--
-- The CHECK reaches across to metric_type on purpose: a text metric claiming a
-- money column is exactly the silent 100x error that ALLOWED_FIELD_TYPES_BY_
-- TARGET exists to stop on the application side, and it belongs in the schema
-- rather than only in the code that happens to write these rows today.
-- =============================================================================
ALTER TABLE metric_definitions ADD COLUMN promotes_to TEXT
  CHECK (promotes_to IS NULL
         OR (promotes_to = 'funds_spent_cents' AND metric_type = 'currency'));

-- One metric per program may claim the column. Two would make the promoted
-- value depend on which answer was written last.
CREATE UNIQUE INDEX metric_definitions_promotes_uniq
  ON metric_definitions (program_id, promotes_to)
  WHERE promotes_to IS NOT NULL AND deleted_at IS NULL;

-- =============================================================================
-- 3. form_fields.metric_definition_id
--
-- Null for every field on every application form, and for the narrative and
-- attachment questions on a report form. Set only on the fields generated from
-- a program's metrics.
--
-- Note what this is NOT: it is not a copy of the metric's label, help text or
-- required flag. Those are copied into the field row when the form is
-- scaffolded and then belong to the FORM, because a published form is frozen
-- and a metric definition is not. Editing a metric's wording next year must not
-- retroactively change the question a grantee answered this year. The reference
-- carries identity only -- which metric this answer counts toward -- and that
-- is the one thing that must survive the wording changing.
-- =============================================================================
ALTER TABLE form_fields ADD COLUMN metric_definition_id TEXT
  REFERENCES metric_definitions(id);

-- One field per metric per form. Two fields reporting the same metric would
-- write two rows into metric_values for one submission, and the unique index
-- there would reject the second -- failing at submit time, in front of a
-- grantee, for a mistake made at configuration time.
CREATE UNIQUE INDEX form_fields_metric_uniq
  ON form_fields (form_definition_id, metric_definition_id)
  WHERE metric_definition_id IS NOT NULL;

CREATE INDEX form_fields_metric_idx
  ON form_fields (metric_definition_id) WHERE metric_definition_id IS NOT NULL;

-- A metric field belongs to a report form. An application form that carried one
-- would have no submission to promote it from.
CREATE TRIGGER form_fields_metric_is_report_only_insert
BEFORE INSERT ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND (SELECT kind FROM form_definitions WHERE id = NEW.form_definition_id) <> 'report'
BEGIN
  SELECT RAISE(ABORT, 'only a report form may carry a metric field');
END;

CREATE TRIGGER form_fields_metric_is_report_only_update
BEFORE UPDATE ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND (SELECT kind FROM form_definitions WHERE id = NEW.form_definition_id) <> 'report'
BEGIN
  SELECT RAISE(ABORT, 'only a report form may carry a metric field');
END;

-- A program's report form reports that program's metrics. Crossing programs
-- would aggregate one program's grantees into another's totals.
CREATE TRIGGER form_fields_metric_same_program_insert
BEFORE INSERT ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND (SELECT program_id FROM metric_definitions WHERE id = NEW.metric_definition_id)
  IS NOT (SELECT program_id FROM form_definitions WHERE id = NEW.form_definition_id)
BEGIN
  SELECT RAISE(ABORT, 'that metric belongs to a different program than this form');
END;

CREATE TRIGGER form_fields_metric_same_program_update
BEFORE UPDATE ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND (SELECT program_id FROM metric_definitions WHERE id = NEW.metric_definition_id)
  IS NOT (SELECT program_id FROM form_definitions WHERE id = NEW.form_definition_id)
BEGIN
  SELECT RAISE(ABORT, 'that metric belongs to a different program than this form');
END;

-- The field type must be able to hold what the metric counts.
--
-- This is the schema-level version of the rule that stopped a short_text field
-- promoting into requested_amount_cents. Without it, a text field reporting a
-- currency metric coerces to value_text, promotion reads a string, and SQLite's
-- TEXT->INTEGER affinity lands "25000" in a cents column as $250.00 with every
-- CHECK passing and nobody told.
CREATE TRIGGER form_fields_metric_type_matches_insert
BEFORE INSERT ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM metric_definitions m
    WHERE m.id = NEW.metric_definition_id
      AND ((m.metric_type = 'integer'  AND NEW.field_type = 'integer')
        OR (m.metric_type = 'currency' AND NEW.field_type = 'currency')
        OR (m.metric_type = 'decimal'  AND NEW.field_type = 'decimal')
        OR (m.metric_type = 'text'     AND NEW.field_type IN ('short_text','long_text')))
 )
BEGIN
  SELECT RAISE(ABORT, 'this field type cannot collect that metric');
END;

CREATE TRIGGER form_fields_metric_type_matches_update
BEFORE UPDATE ON form_fields
WHEN NEW.metric_definition_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM metric_definitions m
    WHERE m.id = NEW.metric_definition_id
      AND ((m.metric_type = 'integer'  AND NEW.field_type = 'integer')
        OR (m.metric_type = 'currency' AND NEW.field_type = 'currency')
        OR (m.metric_type = 'decimal'  AND NEW.field_type = 'decimal')
        OR (m.metric_type = 'text'     AND NEW.field_type IN ('short_text','long_text')))
 )
BEGIN
  SELECT RAISE(ABORT, 'this field type cannot collect that metric');
END;
