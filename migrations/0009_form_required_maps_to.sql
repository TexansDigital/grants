-- 0009_form_required_maps_to.sql
--
-- Per-form promotion requirements.
--
-- `programs.required_maps_to_json` says which maps_to targets a form must
-- collect before it can be published. That was correct while every program had
-- exactly one stage. It stops being correct the moment a program has two.
--
-- Inspire Change is becoming a two-stage program (decision 13): a short
-- eligibility screen that fails fast, then the full application. The universal
-- set is enforced PER FORM DEFINITION, at seed pre-flight and again at publish,
-- so with a single program-wide list the eligibility screen would have to
-- collect a requested amount and a list of counties served before it was
-- allowed to exist -- which is precisely the 34 fields decision 13 exists to
-- stop collecting from an organization that is not eligible.
--
-- CLAUDE.md names "LOI then invited full application" as a shape this platform
-- supports. An LOI genuinely cannot collect a reliable requested amount. So the
-- requirement belongs to the form, not to the program.
--
-- NULL means "inherit the program's list", which is what every existing row
-- does and what a single-stage program should keep doing. Nothing changes for
-- a program that has not opted in.
ALTER TABLE form_definitions ADD COLUMN required_maps_to_json TEXT;

-- Guarded rather than trusted: a malformed value here would otherwise surface
-- as a form that cannot be published, with an error pointing at the fields.
CREATE TRIGGER form_definitions_required_maps_to_valid
BEFORE INSERT ON form_definitions
WHEN NEW.required_maps_to_json IS NOT NULL
 AND (json_valid(NEW.required_maps_to_json) = 0
      OR json_type(NEW.required_maps_to_json) <> 'array')
BEGIN
  SELECT RAISE(ABORT, 'form_definitions.required_maps_to_json must be a JSON array');
END;

CREATE TRIGGER form_definitions_required_maps_to_valid_upd
BEFORE UPDATE OF required_maps_to_json ON form_definitions
WHEN NEW.required_maps_to_json IS NOT NULL
 AND (json_valid(NEW.required_maps_to_json) = 0
      OR json_type(NEW.required_maps_to_json) <> 'array')
BEGIN
  SELECT RAISE(ABORT, 'form_definitions.required_maps_to_json must be a JSON array');
END;
