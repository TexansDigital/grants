/**
 * Turning a stored answer back into something a person reads.
 *
 * This is the inverse of `coerceAnswer`, and it exists for one reason:
 * CLAUDE.md step 10 says the confirmation email carries a read-only copy of
 * everything the applicant submitted, so they hold a record without signing
 * back in. That read-back has to render every field type the form engine
 * supports, on the server, with no browser in the loop.
 *
 * TWO RULES IT MUST NOT BREAK.
 *
 * 1. Money is integer cents everywhere except here. `formatCents` is called at
 *    this edge and nowhere upstream, which is the whole point of the rule --
 *    a cents value that has been through a string is a cents value nobody can
 *    trust again.
 *
 * 2. An empty answer produces nothing, not an empty line. Blank is the normal
 *    state on most fields, and a read-back full of "Not answered" reads like a
 *    list of the applicant's failures rather than a receipt.
 *
 * It is deliberately total over `FieldType`: the switch has no `default`, so
 * adding a field type to the engine without teaching this module about it is a
 * type error rather than a silently blank line in somebody's confirmation.
 */

import type { AnswerLine } from './emailTemplates';
import type { FieldDef, StoredValue } from './fieldTypes';
import { isStoredEmpty } from './fieldTypes';
import type { FormDefinition } from './forms';
import { formatCents } from './money';

/** Address sub-fields, in the order they are read aloud. */
const ADDRESS_ORDER = ['address_1', 'address_2', 'city', 'state', 'postal_code', 'country'];

/**
 * Parse a stored value_json into an array, or an empty one.
 *
 * SHAPE IS CHECKED, not assumed. `JSON.parse('null')` succeeds and returns
 * null, so a try/catch alone let a null through as if it were the fallback and
 * the caller then read a property off it. Every branch below reads structure,
 * so a wrong shape has to become the empty case here rather than a TypeError
 * thrown at somebody mid-submission.
 */
function parseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The same, for an object. Arrays are not objects for this purpose. */
function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `7135550123` -> `713-555-0123`. Stored bare; grouped only for reading. */
function formatPhone(digits: string): string {
  return /^\d{10}$/.test(digits)
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : digits;
}

/**
 * The label for one option value.
 *
 * Falls back to the raw stored value rather than dropping the answer. A
 * published definition is immutable so its options cannot vanish underneath a
 * stored answer, but showing an applicant a blank where they chose something
 * would be a worse failure than showing them an internal-looking value.
 */
function optionLabel(field: FieldDef, value: string): string {
  return field.options.find((o) => o.value === value)?.label ?? value;
}

/**
 * One stored answer as display text, or null when there is nothing to show.
 *
 * Null means "no line". It is distinct from the empty string, which no branch
 * here returns.
 */
export function displayValue(field: FieldDef, stored: StoredValue | undefined | null): string | null {
  if (isStoredEmpty(stored)) return null;
  const v = stored as StoredValue;

  switch (field.field_type) {
    case 'short_text':
    case 'long_text':
    case 'other_specify':
    case 'email':
    case 'url':
      return v.value_text;

    case 'phone':
      return v.value_text === null ? null : formatPhone(v.value_text);

    case 'select':
      return v.value_text === null ? null : optionLabel(field, v.value_text);

    case 'multi_select': {
      const values = parseArray(v.value_json);
      const labels = values
        .filter((x): x is string => typeof x === 'string')
        .map((x) => optionLabel(field, x));
      return labels.length > 0 ? labels.join(', ') : null;
    }

    case 'checkbox_attestation':
    case 'consent_checkbox':
      // value_int 0 is an answer -- the applicant said no -- and isStoredEmpty
      // already distinguishes it from never having answered.
      return v.value_int === 1 ? 'Yes' : 'No';

    case 'currency':
      // The one place cents become dollars.
      return v.value_int === null ? null : formatCents(v.value_int);

    case 'integer':
      return v.value_int === null ? null : v.value_int.toLocaleString('en-US');

    case 'address_block': {
      const addr = parseObject(v.value_json);
      const parts = ADDRESS_ORDER.map((k) => addr[k])
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      return parts.length > 0 ? parts.join(', ') : null;
    }

    case 'file_upload': {
      // Filenames only. An attachment id is an internal reference and a
      // presigned link would be a bearer token sitting in a mailbox forever.
      const refs = parseArray(v.value_json);
      const names = refs
        .map((r) => (r as { filename?: unknown })?.filename)
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      return names.length > 0 ? names.join(', ') : null;
    }
  }
}

/**
 * The whole submission as read-back lines, in the order it was asked.
 *
 * Sections and fields come out in `sort_order`, so the email reads in the same
 * order as the form the applicant filled in. Empty answers are omitted, which
 * means a section every one of whose fields is blank contributes no lines at
 * all and the template renders no heading for it.
 *
 * Answers are keyed by form_field_id, matching what validateSubmission returns.
 */
export function readBackLines(
  definition: FormDefinition,
  answers: ReadonlyMap<string, StoredValue>,
): AnswerLine[] {
  const lines: AnswerLine[] = [];
  const sections = [...definition.sections].sort((a, b) => a.sort_order - b.sort_order);
  for (const section of sections) {
    const fields = [...section.fields].sort((a, b) => a.sort_order - b.sort_order);
    for (const field of fields) {
      const value = displayValue(field, answers.get(field.id));
      if (value === null) continue;
      lines.push({ section: section.title, label: field.label, value });
    }
  }
  return lines;
}
