/**
 * Loading a form definition out of D1, and the publish-time gate.
 *
 * This is the ONLY part of the form engine that touches the database, and it
 * lives apart from forms.ts on purpose: forms.ts is imported by the browser as
 * well as the Worker, and the shared copy must not drag D1 types, the Env type
 * or the error-logging machinery into the client bundle. Splitting the file is
 * what keeps "one definition of the rules, imported by both sides" honest
 * rather than aspirational.
 */

import type { FieldDef, FieldOption, FieldType, FieldValidation } from './fieldTypes';
import type { FormDefinition } from './forms';
import { lintFormDefinition } from './forms';
import { AppError, notFound } from './errors';

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
