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
 * Which field types may promote into which target.
 *
 * This existed nowhere, and its absence was a silent 100x money error waiting
 * to happen. Nothing tied `maps_to = 'requested_amount_cents'` to
 * `field_type = 'currency'`: a short_text field mapped to that target promotes
 * its value_text, `assertCents` is skipped because the value is a string, and
 * SQLite's TEXT->INTEGER affinity then converts "25000" to the integer 25000
 * BEFORE the column's CHECK runs. The CHECK passes. The application is stored
 * as a $250.00 request. Nobody is told.
 *
 * "The last line of defence before a value reaches a money column" in submit.ts
 * only covers field_type === 'currency', so a mis-mapped field walks straight
 * past it. This table is the gate, applied at PUBLISH -- the one moment a human
 * is deciding that a form is ready, and long before an applicant can be harmed
 * by the answer.
 *
 * A target absent from this map accepts any field type.
 */
export const ALLOWED_FIELD_TYPES_BY_TARGET: Partial<Record<MapsToTarget, readonly string[]>> = {
  // Money. Nothing but a currency field, ever.
  requested_amount_cents: ['currency'],
  annual_operating_budget_cents: ['currency'],
  // Identity and contact, where a wrong type silently corrupts a lookup key.
  ein: ['short_text'],
  primary_contact_email: ['email'],
  contact_phone: ['phone'],
  organization_website: ['url'],
  counties_served: ['multi_select'],
  marketing_opt_in: ['consent_checkbox', 'checkbox_attestation'],
  organization_name: ['short_text'],
  project_title: ['short_text'],
  contact_first_name: ['short_text'],
  contact_last_name: ['short_text'],
  contact_job_title: ['short_text'],
  organization_mission: ['long_text', 'short_text'],
};

/**
 * Problems with the maps_to wiring of a form, in publish-gate language.
 *
 * Returns plain sentences rather than throwing, so the caller can report every
 * problem at once alongside the rest of the lint.
 */
export function mapsToTypeProblems(fields: readonly FieldDef[]): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    if (!field.maps_to) continue;
    const target = field.maps_to as MapsToTarget;
    if (!(MAPS_TO_TARGETS as readonly string[]).includes(target)) {
      problems.push(`"${field.label}" promotes to an unknown target "${field.maps_to}".`);
      continue;
    }
    const allowed = ALLOWED_FIELD_TYPES_BY_TARGET[target];
    if (allowed && !allowed.includes(field.field_type)) {
      problems.push(
        `"${field.label}" is a ${field.field_type} field but promotes to ${target}, ` +
          `which requires ${allowed.join(' or ')}.`,
      );
    }
  }
  return problems;
}

/**
 * The DEFAULT required set for an organization-based grant program: the minimum
 * needed for cross-program reporting, duplicate detection, and contacting an
 * applicant.
 *
 * It is a default, not a law. `programs.required_maps_to_json` overrides it per
 * program, because not every program has an applicant organization -- a
 * scholarship or an individual coaches' grant legitimately has no EIN and no
 * organization legal name to collect, and hardcoding this list made such a
 * program impossible to publish at all.
 */
export const DEFAULT_REQUIRED_MAPS_TO: MapsToTarget[] = [
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
export function assertUniversalCoverage(
  fields: readonly FieldDef[],
  required: readonly string[] = DEFAULT_REQUIRED_MAPS_TO,
): void {
  const mapped = new Set(fields.map((f) => f.maps_to).filter(Boolean) as string[]);
  const missing = required.filter((t) => !mapped.has(t));
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
