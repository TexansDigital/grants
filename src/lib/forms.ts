/**
 * Form definition loading and whole-form validation.
 *
 * Submit validates the ENTIRE definition, not just the last section an
 * applicant touched. A form that passes section-by-section and fails as a whole
 * is how somebody loses an hour of work at a deadline.
 */

import type { FieldDef, FieldOption, FieldType, FieldValidation, StoredValue } from './fieldTypes';
import { coerceAnswer } from './fieldTypes';
import { AppError, type FieldError, notFound } from './errors';

export interface SectionDef {
  id: string;
  section_key: string;
  title: string;
  description: string | null;
  sort_order: number;
  fields: FieldDef[];
}

export interface FormDefinition {
  id: string;
  program_id: string;
  stage_id: string;
  kind: 'application' | 'report';
  name: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  sections: SectionDef[];
}

interface FieldRow {
  id: string;
  form_section_id: string;
  field_key: string;
  label: string;
  help_text: string | null;
  field_type: string;
  is_required: number;
  sort_order: number;
  options_json: string | null;
  validation_json: string | null;
  conditional_on_field_id: string | null;
  conditional_value: string | null;
  maps_to: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Malformed configuration must not take down an applicant's form. Fall back
    // to the permissive default and let the definition-lint surface it.
    return fallback;
  }
}

/** Load a full form definition with its sections and fields, ordered. */
export async function loadFormDefinition(
  db: D1Database,
  formDefinitionId: string,
): Promise<FormDefinition> {
  const def = await db
    .prepare(
      `SELECT id, program_id, stage_id, kind, name, version, status
         FROM form_definitions
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(formDefinitionId)
    .first<{
      id: string;
      program_id: string;
      stage_id: string;
      kind: 'application' | 'report';
      name: string;
      version: number;
      status: 'draft' | 'published' | 'retired';
    }>();

  if (!def) throw notFound('form');

  const { results: sectionRows } = await db
    .prepare(
      `SELECT id, section_key, title, description, sort_order
         FROM form_sections
        WHERE form_definition_id = ?
        ORDER BY sort_order, title`,
    )
    .bind(formDefinitionId)
    .all<{
      id: string;
      section_key: string;
      title: string;
      description: string | null;
      sort_order: number;
    }>();

  const { results: fieldRows } = await db
    .prepare(
      `SELECT id, form_section_id, field_key, label, help_text, field_type,
              is_required, sort_order, options_json, validation_json,
              conditional_on_field_id, conditional_value, maps_to
         FROM form_fields
        WHERE form_definition_id = ?
        ORDER BY sort_order, label`,
    )
    .bind(formDefinitionId)
    .all<FieldRow>();

  const fieldsBySection = new Map<string, FieldDef[]>();
  for (const r of fieldRows ?? []) {
    const field: FieldDef = {
      id: r.id,
      field_key: r.field_key,
      label: r.label,
      help_text: r.help_text,
      field_type: r.field_type as FieldType,
      is_required: r.is_required === 1,
      sort_order: r.sort_order,
      options: parseJson<FieldOption[]>(r.options_json, []),
      validation: parseJson<FieldValidation>(r.validation_json, {}),
      conditional_on_field_id: r.conditional_on_field_id,
      conditional_value: r.conditional_value,
      maps_to: r.maps_to,
      section_id: r.form_section_id,
    };
    const list = fieldsBySection.get(r.form_section_id) ?? [];
    list.push(field);
    fieldsBySection.set(r.form_section_id, list);
  }

  return {
    ...def,
    sections: (sectionRows ?? []).map((s) => ({
      ...s,
      fields: fieldsBySection.get(s.id) ?? [],
    })),
  };
}

export function allFields(def: FormDefinition): FieldDef[] {
  return def.sections.flatMap((s) => s.fields);
}

/**
 * Is a conditional field currently visible?
 *
 * A hidden field is never required and its answer is discarded — otherwise an
 * applicant who selects "Other", types a detail, then changes their mind, ships
 * a stale answer that contradicts their selection.
 */
export function isFieldVisible(
  field: FieldDef,
  answersByFieldId: ReadonlyMap<string, StoredValue>,
  fieldsById: ReadonlyMap<string, FieldDef>,
): boolean {
  if (!field.conditional_on_field_id) return true;

  const parent = fieldsById.get(field.conditional_on_field_id);
  if (!parent) return true; // dangling condition: fail open, never hide a field forever

  // A conditional field nested under a hidden parent is itself hidden.
  if (!isFieldVisible(parent, answersByFieldId, fieldsById)) return false;

  const stored = answersByFieldId.get(parent.id);
  if (!stored) return false;

  const expected = field.conditional_value;
  if (expected === null) return true;

  if (parent.field_type === 'multi_select') {
    const selected = parseJson<string[]>(stored.value_json, []);
    return selected.includes(expected);
  }
  if (parent.field_type === 'checkbox_attestation' || parent.field_type === 'consent_checkbox') {
    return String(stored.value_int ?? 0) === expected;
  }
  return (stored.value_text ?? '') === expected;
}

export interface ValidationOutcome {
  errors: FieldError[];
  /** Coerced answers keyed by field id, for fields that are visible. */
  answers: Map<string, StoredValue>;
  /** Fields that were hidden and whose answers should be cleared. */
  hiddenFieldIds: string[];
}

/**
 * Validate a whole submission against a form definition.
 *
 * `raw` is keyed by field_key, which is what a form posts. Errors come back as
 * a list with field keys attached so the review screen can list them at the top
 * with anchors, in plain language, per the submission flow.
 *
 * Two passes are needed: coerce everything first, because visibility of a
 * conditional field depends on the coerced value of its parent.
 */
export function validateSubmission(
  def: FormDefinition,
  raw: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): ValidationOutcome {
  const fields = allFields(def);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const sectionTitleById = new Map(def.sections.map((s) => [s.id, s.title]));

  const errors: FieldError[] = [];
  const coerced = new Map<string, StoredValue>();
  const emptyByFieldId = new Map<string, boolean>();

  // Pass 1 — coerce and type-validate every provided answer.
  for (const field of fields) {
    const rawValue = Object.prototype.hasOwnProperty.call(raw, field.field_key)
      ? raw[field.field_key]
      : undefined;

    if (rawValue === undefined) {
      emptyByFieldId.set(field.id, true);
      continue;
    }

    const result = coerceAnswer(field, rawValue);
    if (!result.ok) {
      errors.push({
        field: field.field_key,
        section: sectionTitleById.get(field.section_id),
        message: result.message,
      });
      emptyByFieldId.set(field.id, true);
      continue;
    }
    coerced.set(field.id, result.stored);
    emptyByFieldId.set(field.id, result.empty);
  }

  // Pass 2 — visibility, required-ness, and discarding hidden answers.
  const hiddenFieldIds: string[] = [];
  const answers = new Map<string, StoredValue>();

  for (const field of fields) {
    const visible = isFieldVisible(field, coerced, fieldsById);
    if (!visible) {
      hiddenFieldIds.push(field.id);
      continue;
    }

    const stored = coerced.get(field.id);
    if (stored) answers.set(field.id, stored);

    // Autosave calls this with partial: true — a half-finished draft is not an
    // error, it is a draft. Required-ness is a submit-time concern.
    if (opts.partial) continue;

    if (!field.is_required) continue;

    const isEmpty = emptyByFieldId.get(field.id) ?? true;
    const isUncheckedAttestation =
      (field.field_type === 'checkbox_attestation' || field.field_type === 'consent_checkbox') &&
      stored?.value_int !== 1;

    if (isEmpty || isUncheckedAttestation) {
      errors.push({
        field: field.field_key,
        section: sectionTitleById.get(field.section_id),
        message: isUncheckedAttestation
          ? `You must confirm: ${field.label}`
          : `${field.label} is required.`,
      });
    }
  }

  return { errors, answers, hiddenFieldIds };
}

/**
 * Configuration lint for a form definition, run before publish.
 *
 * Catches the mistakes that only show up when a real applicant hits the form:
 * a conditional pointing at a field that does not exist, a select with no
 * options, an "other, please specify" with nothing to trigger it.
 */
export function lintFormDefinition(def: FormDefinition): string[] {
  const problems: string[] = [];
  const fields = allFields(def);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const keys = new Set<string>();

  if (def.sections.length === 0) problems.push('The form has no sections.');

  for (const field of fields) {
    if (keys.has(field.field_key)) {
      problems.push(`Duplicate field key "${field.field_key}".`);
    }
    keys.add(field.field_key);

    if ((field.field_type === 'select' || field.field_type === 'multi_select') &&
        field.options.length === 0) {
      problems.push(`"${field.label}" is a choice field with no options.`);
    }

    if (field.conditional_on_field_id) {
      const parent = byId.get(field.conditional_on_field_id);
      if (!parent) {
        problems.push(`"${field.label}" depends on a field that is not in this form.`);
      } else if (
        (parent.field_type === 'select' || parent.field_type === 'multi_select') &&
        field.conditional_value !== null &&
        !parent.options.some((o) => o.value === field.conditional_value)
      ) {
        problems.push(
          `"${field.label}" is revealed by a value ("${field.conditional_value}") that "${parent.label}" does not offer.`,
        );
      }
      // Detect a cycle: a conditional chain that can never resolve.
      const seen = new Set<string>([field.id]);
      let cursor: FieldDef | undefined = parent;
      while (cursor) {
        if (seen.has(cursor.id)) {
          problems.push(`"${field.label}" is part of a circular conditional chain.`);
          break;
        }
        seen.add(cursor.id);
        cursor = cursor.conditional_on_field_id ? byId.get(cursor.conditional_on_field_id) : undefined;
      }
    }

    if (field.field_type === 'other_specify' && !field.conditional_on_field_id) {
      problems.push(`"${field.label}" is an "other, please specify" field with no trigger.`);
    }
  }

  return problems;
}

/** Throw the lint result as a client-facing error, for the publish endpoint. */
export function assertPublishable(def: FormDefinition): void {
  const problems = lintFormDefinition(def);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'This form cannot be published yet.', {
      internalMessage: `form definition ${def.id} failed lint`,
      severity: 'warn',
      context: { problems },
      fieldErrors: problems.map((p) => ({ field: '_form', message: p })),
    });
  }
}
