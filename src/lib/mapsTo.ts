/**
 * maps_to promotion.
 *
 * A field flagged `maps_to` promotes its answer into a first-class column on
 * `applications`. This is mandatory infrastructure, not a nicety: without it,
 * "how much did we award across all programs in FY26" means parsing an answers
 * table forever.
 *
 * Promotion runs INSIDE the same atomic batch as the answer writes, so the
 * promoted column and the answer it came from can never disagree. The answer
 * row remains the source of truth; the column is a denormalization.
 */

import type { FieldDef } from './fieldTypes';
import type { StoredValue } from './fieldTypes';
import { normalizeEin } from './ein';
import { AppError } from './errors';

export const MAPS_TO_TARGETS = [
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
  'marketing_opt_in',
] as const;

export type MapsToTarget = (typeof MAPS_TO_TARGETS)[number];

/**
 * Every program's application form MUST map this set. It is the minimum needed
 * for cross-program reporting, duplicate detection, and contacting an applicant.
 * A form definition that does not cover it cannot be published.
 */
export const UNIVERSAL_MAPS_TO: MapsToTarget[] = [
  'organization_name',
  'ein',
  'requested_amount_cents',
  'primary_contact_email',
  'counties_served',
];

/** Which promoted targets land on `applications` vs. `organizations`/`contacts`. */
export const APPLICATION_COLUMN_BY_TARGET: Partial<Record<MapsToTarget, string>> = {
  organization_name: 'organization_name_at_submit',
  ein: 'ein_at_submit',
  requested_amount_cents: 'requested_amount_cents',
  primary_contact_email: 'primary_contact_email',
  counties_served: 'counties_served_json',
  project_title: 'project_title',
};

export const ORGANIZATION_COLUMN_BY_TARGET: Partial<Record<MapsToTarget, string>> = {
  organization_name: 'legal_name',
  ein: 'ein',
  organization_website: 'website',
  organization_mission: 'mission',
  annual_operating_budget_cents: 'annual_operating_budget_cents',
};

export const CONTACT_COLUMN_BY_TARGET: Partial<Record<MapsToTarget, string>> = {
  primary_contact_email: 'email',
  contact_first_name: 'first_name',
  contact_last_name: 'last_name',
  contact_phone: 'phone',
  contact_job_title: 'job_title',
  marketing_opt_in: 'marketing_opt_in',
};

export interface PromotedValues {
  application: Record<string, string | number | null>;
  organization: Record<string, string | number | null>;
  contact: Record<string, string | number | null>;
}

/**
 * Read the storage shape back into a promotable scalar.
 *
 * Currency and integer live in value_int and stay integers. Multi-select stays
 * JSON. Everything else is text.
 */
function scalarFor(field: FieldDef, stored: StoredValue): string | number | null {
  switch (field.field_type) {
    case 'currency':
    case 'integer':
    case 'checkbox_attestation':
    case 'consent_checkbox':
      return stored.value_int;
    case 'multi_select':
    case 'address_block':
    case 'file_upload':
      return stored.value_json;
    default:
      return stored.value_text;
  }
}

/**
 * Compute promoted column values from coerced answers.
 *
 * `answers` is keyed by field id. Fields with no maps_to are ignored.
 */
export function promote(
  fields: readonly FieldDef[],
  answers: ReadonlyMap<string, StoredValue>,
): PromotedValues {
  const out: PromotedValues = { application: {}, organization: {}, contact: {} };

  for (const field of fields) {
    if (!field.maps_to) continue;
    const stored = answers.get(field.id);
    if (!stored) continue;

    const target = field.maps_to as MapsToTarget;
    let value = scalarFor(field, stored);

    // EIN is normalized to nine digits wherever it is promoted, so the same
    // nonprofit typed two different ways lands on one organization row.
    if (target === 'ein' && typeof value === 'string') {
      value = normalizeEin(value);
    }
    if (target === 'primary_contact_email' && typeof value === 'string') {
      value = value.trim().toLowerCase();
    }

    const appCol = APPLICATION_COLUMN_BY_TARGET[target];
    if (appCol) out.application[appCol] = value;

    const orgCol = ORGANIZATION_COLUMN_BY_TARGET[target];
    if (orgCol) out.organization[orgCol] = value;

    const contactCol = CONTACT_COLUMN_BY_TARGET[target];
    if (contactCol) out.contact[contactCol] = value;
  }

  return out;
}

/**
 * Refuse to publish a form definition that does not map the universal set.
 *
 * Called at publish time, not at submit time — the failure belongs to the admin
 * configuring the program, not to the applicant filling it in.
 */
export function assertUniversalCoverage(fields: readonly FieldDef[]): void {
  const mapped = new Set(fields.map((f) => f.maps_to).filter(Boolean) as string[]);
  const missing = UNIVERSAL_MAPS_TO.filter((t) => !mapped.has(t));
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This form cannot be published until it collects: ${missing.join(', ')}.`,
      {
        internalMessage: `form definition missing universal maps_to targets: ${missing.join(', ')}`,
        severity: 'warn',
        context: { missing },
      },
    );
  }
}

/**
 * A second guard for the unique index on (form_definition_id, maps_to).
 *
 * The database already refuses a duplicate. This produces the plain-language
 * version for an admin instead of a constraint violation.
 */
export function assertNoDuplicateTargets(fields: readonly FieldDef[]): void {
  const seen = new Map<string, string>();
  for (const f of fields) {
    if (!f.maps_to) continue;
    const prior = seen.get(f.maps_to);
    if (prior) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Two fields both claim "${f.maps_to}": "${prior}" and "${f.label}". Only one field may map to each target.`,
        {
          internalMessage: `duplicate maps_to ${f.maps_to}`,
          severity: 'warn',
          context: { target: f.maps_to },
        },
      );
    }
    seen.set(f.maps_to, f.label);
  }
}
