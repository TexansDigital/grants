/**
 * Field type registry.
 *
 * ONE definition of each field type: how it validates and where it stores.
 * Imported by the Worker for server-side validation and (Phase 1) by the React
 * renderer for client-side validation, so the two can never drift. A form the
 * browser accepts and the server rejects is a bug report from an applicant at
 * 11pm on deadline day.
 *
 * Server-side validation is authoritative regardless. Client-side validation is
 * a courtesy to the applicant, never a control.
 */

import { parseCurrencyToCents, MoneyParseError } from './money';

export type FieldType =
  | 'short_text'
  | 'long_text'
  | 'email'
  | 'phone'
  | 'select'
  | 'multi_select'
  | 'checkbox_attestation'
  | 'currency'
  | 'integer'
  | 'url'
  | 'address_block'
  | 'file_upload'
  | 'consent_checkbox'
  | 'other_specify';

/** Where a coerced answer lands in application_answers. */
export interface StoredValue {
  value_text: string | null;
  value_int: number | null;
  value_real: number | null;
  value_json: string | null;
}

export const EMPTY_VALUE: StoredValue = {
  value_text: null,
  value_int: null,
  value_real: null,
  value_json: null,
};

/**
 * Is a stored answer actually empty?
 *
 * All four value columns null. This exists because "has a row" and "has an
 * answer" are not the same thing and were being treated as if they were: a
 * blank answer coerces to EMPTY_VALUE and was written as an all-NULL row, and
 * required-ness then asked only whether a row existed. Every required field
 * except the attestations could be defeated by answering it with "".
 *
 * An unchecked attestation has value_int = 0, which is NOT empty -- the
 * applicant answered, and the answer was no. That distinction is the whole
 * reason this is a function and not `Object.values(v).every(x => x === null)`
 * written inline at three call sites.
 */
export function isStoredEmpty(value: StoredValue | undefined | null): boolean {
  if (!value) return true;
  return (
    value.value_text === null &&
    value.value_int === null &&
    value.value_real === null &&
    value.value_json === null
  );
}

export interface FieldOption {
  value: string;
  label: string;
  /** Selecting this option reveals the paired 'other_specify' field. */
  triggers_other?: boolean;
}

export interface FieldValidation {
  min_length?: number;
  max_length?: number;
  /** Word count bounds for narrative fields; applicants think in words. */
  min_words?: number;
  max_words?: number;
  pattern?: string;
  /**
   * What to say when `pattern` fails.
   *
   * "is not in the expected format" tells an applicant nothing -- least of all
   * on the field they are most likely to have pasted from a PDF. A program
   * that sets a pattern should say what shape it wants.
   */
  pattern_message?: string;
  min?: number;
  max?: number;
  /** currency, in cents, after parsing. */
  min_cents?: number;
  max_cents?: number;
  allowed_mime?: string[];
  max_size_bytes?: number;
  max_files?: number;
  /** address_block: which sub-fields are required. */
  required_parts?: string[];
}

export interface FieldDef {
  id: string;
  field_key: string;
  label: string;
  help_text?: string | null;
  field_type: FieldType;
  is_required: boolean;
  sort_order: number;
  options: FieldOption[];
  validation: FieldValidation;
  conditional_on_field_id: string | null;
  conditional_value: string | null;
  maps_to: string | null;
  section_id: string;
}

/**
 * One problem with one answer, in language an applicant can act on.
 *
 * Lives here rather than in errors.ts so that the pure form modules -- and the
 * browser that imports them -- never have to pull in the Worker error and
 * logging machinery. errors.ts re-exports it, so existing importers are
 * unaffected.
 */
export interface FieldError {
  /** field_key, so the UI can anchor to the input. */
  field: string;
  section?: string;
  /** Plain language. An applicant reads this. */
  message: string;
}

export type CoerceResult =
  | { ok: true; stored: StoredValue; empty: boolean }
  | { ok: false; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i;
/** North American phone: 10 digits, or 11 starting with 1. */
const PHONE_DIGITS = /^1?\d{10}$/;

const ADDRESS_PARTS = [
  'address_1',
  'address_2',
  'city',
  'state',
  'postal_code',
  'country',
] as const;

function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function words(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function textLimits(value: string, v: FieldValidation, label: string): string | null {
  if (v.min_length !== undefined && value.length < v.min_length) {
    return `${label} must be at least ${v.min_length} characters.`;
  }
  if (v.max_length !== undefined && value.length > v.max_length) {
    return `${label} must be ${v.max_length} characters or fewer. It is currently ${value.length}.`;
  }
  const w = words(value);
  if (v.min_words !== undefined && w < v.min_words) {
    return `${label} must be at least ${v.min_words} words. It is currently ${w}.`;
  }
  if (v.max_words !== undefined && w > v.max_words) {
    return `${label} must be ${v.max_words} words or fewer. It is currently ${w}.`;
  }
  if (v.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(v.pattern);
    } catch {
      // A bad pattern in configuration must not reject a valid answer.
      return null;
    }
    if (!re.test(value)) return v.pattern_message ?? `${label} is not in the expected format.`;
  }
  return null;
}

/**
 * Coerce and validate one raw answer for one field.
 *
 * Returns the storage shape, or a plain-language message an applicant can act
 * on. Required-ness is NOT checked here — that depends on conditional
 * visibility, which is a form-level concern. See forms.ts.
 */
export function coerceAnswer(field: FieldDef, raw: unknown): CoerceResult {
  const v = field.validation ?? {};
  const label = field.label;

  if (isBlank(raw)) return { ok: true, stored: { ...EMPTY_VALUE }, empty: true };

  switch (field.field_type) {
    case 'short_text':
    case 'long_text':
    case 'other_specify': {
      const s = String(raw).trim();
      const err = textLimits(s, v, label);
      if (err) return { ok: false, message: err };
      return { ok: true, stored: { ...EMPTY_VALUE, value_text: s }, empty: false };
    }

    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(s)) {
        return { ok: false, message: `Enter a valid email address for ${label}.` };
      }
      if (s.length > 320) return { ok: false, message: `${label} is too long.` };
      return { ok: true, stored: { ...EMPTY_VALUE, value_text: s }, empty: false };
    }

    case 'phone': {
      const digits = String(raw).replace(/\D/g, '');
      if (!PHONE_DIGITS.test(digits)) {
        return {
          ok: false,
          message: `Enter a 10-digit phone number for ${label}, for example 713-555-0123.`,
        };
      }
      const ten = digits.length === 11 ? digits.slice(1) : digits;
      return { ok: true, stored: { ...EMPTY_VALUE, value_text: ten }, empty: false };
    }

    case 'url': {
      let s = String(raw).trim();
      // Applicants type "example.org". Accept it rather than scolding them.
      if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
      if (!URL_RE.test(s)) {
        return { ok: false, message: `Enter a valid web address for ${label}.` };
      }
      return { ok: true, stored: { ...EMPTY_VALUE, value_text: s }, empty: false };
    }

    case 'select': {
      const s = String(raw).trim();
      const allowed = field.options.map((o) => o.value);
      if (!allowed.includes(s)) {
        return { ok: false, message: `Choose one of the listed options for ${label}.` };
      }
      return { ok: true, stored: { ...EMPTY_VALUE, value_text: s }, empty: false };
    }

    case 'multi_select': {
      const arr = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : [String(raw).trim()];
      const allowed = new Set(field.options.map((o) => o.value));
      const unknown = arr.filter((x) => !allowed.has(x));
      if (unknown.length > 0) {
        return { ok: false, message: `Choose only from the listed options for ${label}.` };
      }
      const unique = [...new Set(arr)].sort();
      if (v.max !== undefined && unique.length > v.max) {
        return { ok: false, message: `Choose at most ${v.max} options for ${label}.` };
      }
      if (v.min !== undefined && unique.length < v.min) {
        return { ok: false, message: `Choose at least ${v.min} options for ${label}.` };
      }
      return {
        ok: true,
        stored: { ...EMPTY_VALUE, value_json: JSON.stringify(unique) },
        empty: false,
      };
    }

    case 'checkbox_attestation':
    case 'consent_checkbox': {
      // Stored as 0/1 in value_int so it aggregates without parsing JSON.
      const truthy = raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on';
      const falsy = raw === false || raw === 0 || raw === '0' || raw === 'false';
      if (!truthy && !falsy) {
        return { ok: false, message: `${label} must be checked or left unchecked.` };
      }
      return {
        ok: true,
        stored: { ...EMPTY_VALUE, value_int: truthy ? 1 : 0 },
        // An unchecked attestation is NOT "empty": the applicant answered no.
        // Required-ness for attestations is checked separately in forms.ts.
        empty: false,
      };
    }

    case 'currency': {
      let cents: number;
      try {
        cents = parseCurrencyToCents(raw);
      } catch (e) {
        const msg = e instanceof MoneyParseError ? e.message : 'Enter a dollar amount.';
        return { ok: false, message: `${label}: ${msg}` };
      }
      if (v.min_cents !== undefined && cents < v.min_cents) {
        return { ok: false, message: `${label} must be at least $${(v.min_cents / 100).toLocaleString('en-US')}.` };
      }
      if (v.max_cents !== undefined && cents > v.max_cents) {
        return { ok: false, message: `${label} must be no more than $${(v.max_cents / 100).toLocaleString('en-US')}.` };
      }
      // INTEGER CENTS, into value_int. Never value_real. Never a string.
      return { ok: true, stored: { ...EMPTY_VALUE, value_int: cents }, empty: false };
    }

    case 'integer': {
      const s = String(raw).trim().replace(/,/g, '');
      if (!/^-?\d+$/.test(s)) {
        return { ok: false, message: `${label} must be a whole number.` };
      }
      const n = Number(s);
      if (!Number.isSafeInteger(n)) {
        return { ok: false, message: `${label} is too large.` };
      }
      if (v.min !== undefined && n < v.min) {
        return { ok: false, message: `${label} must be at least ${v.min}.` };
      }
      if (v.max !== undefined && n > v.max) {
        return { ok: false, message: `${label} must be no more than ${v.max}.` };
      }
      return { ok: true, stored: { ...EMPTY_VALUE, value_int: n }, empty: false };
    }

    case 'address_block': {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, message: `Enter an address for ${label}.` };
      }
      const src = raw as Record<string, unknown>;
      const addr: Record<string, string> = {};
      for (const part of ADDRESS_PARTS) {
        const val = src[part];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          addr[part] = String(val).trim();
        }
      }
      const requiredParts = v.required_parts ?? ['address_1', 'city', 'state', 'postal_code'];
      const missing = requiredParts.filter((p) => !addr[p]);
      if (missing.length > 0) {
        return {
          ok: false,
          message: `${label} is missing ${missing.map(humanizePart).join(', ')}.`,
        };
      }
      if (addr.postal_code && !/^\d{5}(-\d{4})?$/.test(addr.postal_code)) {
        return { ok: false, message: `Enter a valid ZIP code for ${label}.` };
      }
      if (addr.state && !/^[A-Za-z]{2}$/.test(addr.state)) {
        return { ok: false, message: `Enter a two-letter state code for ${label}.` };
      }
      if (addr.state) addr.state = addr.state.toUpperCase();
      return {
        ok: true,
        stored: { ...EMPTY_VALUE, value_json: JSON.stringify(addr) },
        empty: false,
      };
    }

    case 'file_upload': {
      // The answer is attachment metadata, not a file. Bytes go direct to R2 via
      // a presigned PUT; the Worker only ever sees the object key.
      const list = Array.isArray(raw) ? raw : [raw];
      const maxFiles = v.max_files ?? 1;
      if (list.length > maxFiles) {
        return { ok: false, message: `Attach at most ${maxFiles} file(s) for ${label}.` };
      }
      const refs: { attachment_id: string; filename: string }[] = [];
      for (const item of list) {
        if (typeof item !== 'object' || item === null) {
          return { ok: false, message: `${label} could not be read. Try uploading again.` };
        }
        const o = item as Record<string, unknown>;
        const attachmentId = typeof o.attachment_id === 'string' ? o.attachment_id : null;
        const filename = typeof o.filename === 'string' ? o.filename : null;
        if (!attachmentId || !filename) {
          return { ok: false, message: `${label} could not be read. Try uploading again.` };
        }
        // The client controls this payload entirely, so neither value is
        // trusted here. The id is only accepted as a reference to be resolved
        // against attachments the session's organization owns (see
        // resolveAttachments in submit.ts); the display name is sanitized so it
        // cannot carry markup or a traversal sequence into the staff review UI.
        if (!/^[0-9a-zA-Z_-]{1,64}$/.test(attachmentId)) {
          return { ok: false, message: `${label} could not be read. Try uploading again.` };
        }
        const safeName = filename
          .replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e<>"'`]/g, '')
          .trim()
          .slice(0, 200);
        if (safeName === '') {
          return { ok: false, message: `${label} has an unsupported file name.` };
        }
        refs.push({ attachment_id: attachmentId, filename: safeName });
      }
      return {
        ok: true,
        stored: { ...EMPTY_VALUE, value_json: JSON.stringify(refs) },
        empty: refs.length === 0,
      };
    }

    default: {
      // Exhaustiveness: a new field type added to the union without a case here
      // becomes a compile error rather than a silent pass-through.
      const never: never = field.field_type;
      return { ok: false, message: `Unsupported field type: ${String(never)}` };
    }
  }
}

function humanizePart(part: string): string {
  return part.replace(/_/g, ' ').replace('address 1', 'street address').replace('postal code', 'ZIP code');
}

/**
 * Upload constraints enforced server-side before a presigned URL is issued.
 *
 * R2 does no malware scanning. Type and size limits are not safety; they are
 * the floor. Files are never rendered inline and are served only through
 * short-lived signed URLs with a forced download disposition.
 */
export const DEFAULT_UPLOAD_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/csv',
  'image/png',
  'image/jpeg',
];

export const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

export function validateUploadIntent(
  field: FieldDef,
  intent: { filename: string; mimeType: string; sizeBytes: number },
): { ok: true } | { ok: false; message: string } {
  const v = field.validation ?? {};
  const allowed = v.allowed_mime ?? DEFAULT_UPLOAD_MIME;
  const maxBytes = v.max_size_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  if (!allowed.includes(intent.mimeType)) {
    return {
      ok: false,
      message: `${field.label} must be a PDF, Word, Excel, CSV, or image file.`,
    };
  }
  if (!Number.isInteger(intent.sizeBytes) || intent.sizeBytes <= 0) {
    return { ok: false, message: `${field.label} could not be read. Try uploading again.` };
  }
  if (intent.sizeBytes > maxBytes) {
    return {
      ok: false,
      message: `${field.label} must be smaller than ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    };
  }
  if (/[\\/\x00-\x1f]/.test(intent.filename) || intent.filename.length > 255) {
    return { ok: false, message: `${field.label} has an unsupported file name.` };
  }
  return { ok: true };
}
