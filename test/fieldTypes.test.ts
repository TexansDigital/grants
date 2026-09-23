import { describe, it, expect } from 'vitest';
import {
  coerceAnswer,
  validateUploadIntent,
  acceptAttribute,
  mimeForUpload,
  MEDIA_UPLOAD_MIME,
  DEFAULT_UPLOAD_MIME,
  type FieldDef,
  type FieldType,
} from '../src/lib/fieldTypes';

function field(over: Partial<FieldDef> & { field_type: FieldType }): FieldDef {
  return {
    id: 'f1',
    field_key: 'k',
    label: 'Test field',
    help_text: null,
    is_required: false,
    sort_order: 0,
    options: [],
    validation: {},
    conditional_on_field_id: null,
    conditional_value: null,
    maps_to: null,
    section_id: 's1',
    ...over,
  };
}

const ALL_TYPES: FieldType[] = [
  'short_text', 'long_text', 'email', 'phone', 'select', 'multi_select',
  'checkbox_attestation', 'currency', 'integer', 'decimal', 'url', 'address_block',
  'file_upload', 'consent_checkbox', 'other_specify',
];

describe('field type registry', () => {
  it('degrades gracefully on blank for every type', () => {
    // NOTE: this asserts ONLY the blank path. coerceAnswer returns before the
    // type switch on blank input, so this proves nothing about any individual
    // type -- the per-type round-trip tests below are what actually cover them.
    for (const t of ALL_TYPES) {
      const f = field({ field_type: t, options: [{ value: 'a', label: 'A' }] });
      const blank = coerceAnswer(f, '');
      expect(blank.ok, `${t} should accept blank`).toBe(true);
      if (blank.ok) expect(blank.empty).toBe(true);
    }
  });

  it('gives every type a real round trip, so a missing implementation fails', () => {
    const samples: Record<FieldType, unknown> = {
      short_text: 'hello',
      long_text: 'a longer answer',
      email: 'a@example.org',
      phone: '7135550123',
      select: 'a',
      multi_select: ['a'],
      checkbox_attestation: true,
      currency: '$1,234.56',
      integer: '42',
      decimal: '12.5',
      url: 'example.org',
      address_block: { address_1: '1 Main', city: 'Houston', state: 'TX', postal_code: '77002' },
      file_upload: [{ attachment_id: 'att1', filename: 'f.pdf' }],
      consent_checkbox: true,
      other_specify: 'something else',
    };
    // Guards against a type being dropped from the union or the sample map.
    expect(Object.keys(samples).sort()).toEqual([...ALL_TYPES].sort());

    for (const t of ALL_TYPES) {
      const f = field({ field_type: t, options: [{ value: 'a', label: 'A' }] });
      const r = coerceAnswer(f, samples[t]);
      expect(r.ok, `${t} failed to coerce a valid sample`).toBe(true);
      if (r.ok) {
        expect(r.empty, `${t} treated a real value as empty`).toBe(false);
        const stored = r.stored;
        const populated = [stored.value_text, stored.value_int, stored.value_real, stored.value_json]
          .filter((v) => v !== null);
        expect(populated.length, `${t} stored nothing`).toBe(1);
      }
    }
  });

  it('decimal is the only type that writes value_real', () => {
    const f = field({ field_type: 'decimal' });
    const r = coerceAnswer(f, '12.5');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stored.value_real).toBe(12.5);
      expect(r.stored.value_int).toBeNull();
      expect(r.stored.value_text).toBeNull();
    }
  });

  it('decimal accepts a whole number without turning it into an integer answer', () => {
    // A grantee who reports 12 volunteer hours has answered a decimal
    // question. Landing that in value_int would split one metric across two
    // columns and make the SUM that reads it wrong.
    const r = coerceAnswer(field({ field_type: 'decimal' }), '12');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stored.value_real).toBe(12);
      expect(r.stored.value_int).toBeNull();
    }
  });

  it('decimal refuses exponent notation, which is a typo far more often', () => {
    const r = coerceAnswer(field({ field_type: 'decimal' }), '1e3');
    expect(r.ok).toBe(false);
  });

  it('decimal refuses text and a bare minus sign', () => {
    for (const bad of ['abc', '-', '.', '1.2.3', '12,5,0.']) {
      expect(coerceAnswer(field({ field_type: 'decimal' }), bad).ok, bad).toBe(false);
    }
  });

  it('decimal strips thousands separators like integer does', () => {
    const r = coerceAnswer(field({ field_type: 'decimal' }), '1,234.5');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stored.value_real).toBe(1234.5);
  });

  it('decimal honours min and max', () => {
    const f = field({ field_type: 'decimal', validation: { min: 0, max: 100 } });
    expect(coerceAnswer(f, '-0.5').ok).toBe(false);
    expect(coerceAnswer(f, '100.1').ok).toBe(false);
    expect(coerceAnswer(f, '99.9').ok).toBe(true);
  });

  it('short_text enforces length and pattern', () => {
    const f = field({ field_type: 'short_text', validation: { max_length: 5 } });
    expect(coerceAnswer(f, 'abc')).toMatchObject({ ok: true });
    expect(coerceAnswer(f, 'abcdefgh')).toMatchObject({ ok: false });
  });

  it('long_text counts words, because applicants think in words', () => {
    const f = field({ field_type: 'long_text', validation: { max_words: 3 } });
    const bad = coerceAnswer(f, 'one two three four');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('4');
    expect(coerceAnswer(f, 'one two three')).toMatchObject({ ok: true });
  });

  it('email normalizes case and rejects malformed input', () => {
    const f = field({ field_type: 'email' });
    const r = coerceAnswer(f, '  Director@Example.ORG ');
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.stored.value_text).toBe('director@example.org');
    expect(coerceAnswer(f, 'nope')).toMatchObject({ ok: false });
    expect(coerceAnswer(f, 'a@b')).toMatchObject({ ok: false });
  });

  it('phone stores ten digits regardless of how it was typed', () => {
    const f = field({ field_type: 'phone' });
    for (const input of ['713-555-0123', '(713) 555-0123', '7135550123', '1-713-555-0123']) {
      const r = coerceAnswer(f, input);
      expect(r, input).toMatchObject({ ok: true });
      if (r.ok) expect(r.stored.value_text).toBe('7135550123');
    }
    expect(coerceAnswer(f, '555')).toMatchObject({ ok: false });
  });

  it('url accepts a bare domain rather than scolding the applicant', () => {
    const f = field({ field_type: 'url' });
    const r = coerceAnswer(f, 'example.org');
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.stored.value_text).toBe('https://example.org');
    expect(coerceAnswer(f, 'not a url')).toMatchObject({ ok: false });
  });

  it('select rejects a value not in its options', () => {
    const f = field({ field_type: 'select', options: [{ value: 'a', label: 'A' }] });
    expect(coerceAnswer(f, 'a')).toMatchObject({ ok: true });
    // The important case: a tampered POST body cannot inject an arbitrary value.
    expect(coerceAnswer(f, 'admin')).toMatchObject({ ok: false });
  });

  it('multi_select deduplicates, sorts, and bounds', () => {
    const f = field({
      field_type: 'multi_select',
      options: [
        { value: 'harris', label: 'Harris' },
        { value: 'waller', label: 'Waller' },
      ],
      validation: { min: 1, max: 2 },
    });
    const r = coerceAnswer(f, ['waller', 'harris', 'harris']);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(JSON.parse(r.stored.value_json!)).toEqual(['harris', 'waller']);
    expect(coerceAnswer(f, ['harris', 'nowhere'])).toMatchObject({ ok: false });
  });

  it('currency lands in value_int as integer cents and never in value_real', () => {
    const f = field({ field_type: 'currency' });
    const r = coerceAnswer(f, '$25,000.07');
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.stored.value_int).toBe(2_500_007);
      expect(Number.isInteger(r.stored.value_int)).toBe(true);
      expect(r.stored.value_real).toBeNull();
      expect(r.stored.value_text).toBeNull();
    }
  });

  it('currency honours min and max bounds in cents', () => {
    const f = field({ field_type: 'currency', validation: { min_cents: 500_000, max_cents: 10_000_000 } });
    expect(coerceAnswer(f, '1000')).toMatchObject({ ok: false });
    expect(coerceAnswer(f, '250000')).toMatchObject({ ok: false });
    expect(coerceAnswer(f, '25000')).toMatchObject({ ok: true });
  });

  it('integer rejects decimals', () => {
    const f = field({ field_type: 'integer', validation: { min: 1, max: 1000 } });
    expect(coerceAnswer(f, '400')).toMatchObject({ ok: true });
    expect(coerceAnswer(f, '400.5')).toMatchObject({ ok: false });
    expect(coerceAnswer(f, '0')).toMatchObject({ ok: false });
    expect(coerceAnswer(f, '5000')).toMatchObject({ ok: false });
  });

  it('attestations record an explicit no rather than treating it as blank', () => {
    const f = field({ field_type: 'checkbox_attestation' });
    const yes = coerceAnswer(f, true);
    const no = coerceAnswer(f, false);
    expect(yes).toMatchObject({ ok: true });
    expect(no).toMatchObject({ ok: true });
    if (yes.ok) expect(yes.stored.value_int).toBe(1);
    if (no.ok) {
      expect(no.stored.value_int).toBe(0);
      // An unchecked box is an ANSWER, not an absence. Required-ness is checked
      // separately so "I did not agree" is distinguishable from "I skipped it".
      expect(no.empty).toBe(false);
    }
  });

  it('address_block requires the parts the program says it requires', () => {
    const f = field({ field_type: 'address_block' });
    expect(
      coerceAnswer(f, { address_1: '1 Main', city: 'Houston', state: 'tx', postal_code: '77002' }),
    ).toMatchObject({ ok: true });
    const missing = coerceAnswer(f, { address_1: '1 Main' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('city');
    expect(coerceAnswer(f, { address_1: '1', city: 'H', state: 'TX', postal_code: 'abc' })).toMatchObject({ ok: false });
  });

  it('address_block uppercases the state code', () => {
    const f = field({ field_type: 'address_block' });
    const r = coerceAnswer(f, { address_1: '1 Main', city: 'Houston', state: 'tx', postal_code: '77002' });
    if (r.ok) expect(JSON.parse(r.stored.value_json!).state).toBe('TX');
  });

  it('file_upload stores attachment references, never file bytes', () => {
    const f = field({ field_type: 'file_upload', validation: { max_files: 2 } });
    const r = coerceAnswer(f, [{ attachment_id: 'att-1', filename: 'budget.pdf' }]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(JSON.parse(r.stored.value_json!)).toEqual([{ attachment_id: 'att-1', filename: 'budget.pdf' }]);
    expect(
      coerceAnswer(f, [
        { attachment_id: 'a', filename: 'x' },
        { attachment_id: 'b', filename: 'y' },
        { attachment_id: 'c', filename: 'z' },
      ]),
    ).toMatchObject({ ok: false });
  });
});

describe('upload intent validation', () => {
  const f = field({ field_type: 'file_upload' });

  it('accepts the document types nonprofits actually send', () => {
    expect(validateUploadIntent(f, { filename: 'audit.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }))
      .toEqual({ ok: true });
  });

  it('rejects executables and oversized files', () => {
    expect(validateUploadIntent(f, { filename: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 }).ok)
      .toBe(false);
    expect(validateUploadIntent(f, { filename: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 99_000_000 }).ok)
      .toBe(false);
  });

  it('rejects a path-traversal filename', () => {
    expect(validateUploadIntent(f, { filename: '../../etc/passwd', mimeType: 'application/pdf', sizeBytes: 10 }).ok)
      .toBe(false);
  });
});

/*
 * The accept attribute is the picker's filter, not ours, and a file it hides
 * is a file the grantee cannot choose and is given no reason for. These tests
 * exist because the media field listed mime types only, and the two types a
 * phone actually produces are the two Chrome cannot map on its own.
 */
describe('acceptAttribute', () => {
  it('offers the extensions a phone produces, not only the mime types', () => {
    const accept = acceptAttribute(MEDIA_UPLOAD_MIME);
    // Chrome on Windows and Android maps neither of these types to a file, so
    // without the extension every iPhone photo is greyed out in the picker.
    expect(accept).toContain('.heic');
    expect(accept).toContain('.heif');
    expect(accept).toContain('.mov');
    expect(accept).toContain('.mp4');
  });

  it('keeps the mime types as well, for the browsers that do map them', () => {
    const accept = acceptAttribute(MEDIA_UPLOAD_MIME);
    for (const mime of MEDIA_UPLOAD_MIME) expect(accept).toContain(mime);
  });

  it('filters a document field too, instead of showing every file on the machine', () => {
    const accept = acceptAttribute(undefined);
    expect(accept).toContain('application/pdf');
    expect(accept).toContain('.pdf');
    expect(accept).toContain('.docx');
    expect(accept).toContain('.xlsx');
  });

  it('offers no video extension on a document field', () => {
    expect(acceptAttribute(undefined)).not.toContain('.mov');
  });

  it('every extension it offers resolves to a type the field allows', () => {
    // The picker and the rule must not disagree: a file admitted here by its
    // extension has to survive validateUploadIntent, or the grantee picks a
    // file the form then refuses.
    for (const allowed of [MEDIA_UPLOAD_MIME, DEFAULT_UPLOAD_MIME]) {
      const extensions = acceptAttribute(allowed)
        .split(',')
        .filter((part) => part.startsWith('.'));
      expect(extensions.length).toBeGreaterThan(0);
      for (const ext of extensions) {
        // An empty declared type is the case the extension is there to cover.
        expect(allowed).toContain(mimeForUpload(`photo${ext}`, ''));
      }
    }
  });
});

describe('a file the browser would not name', () => {
  const media = field({
    field_type: 'file_upload',
    label: 'Photos and video',
    validation: { allowed_mime: MEDIA_UPLOAD_MIME, max_size_bytes: 200 * 1024 * 1024 },
  });

  it('accepts a HEIC photo the operating system had no type for', () => {
    expect(
      validateUploadIntent(media, { filename: 'IMG_4821.HEIC', mimeType: '', sizeBytes: 3_200_000 })
        .ok,
    ).toBe(true);
  });

  it('accepts a .mov clip the operating system had no type for', () => {
    expect(
      validateUploadIntent(media, { filename: 'clip.mov', mimeType: '', sizeBytes: 40_000_000 }).ok,
    ).toBe(true);
  });

  it('accepts a Word document the operating system had no type for', () => {
    const doc = field({ field_type: 'file_upload', label: 'Documents' });
    expect(
      validateUploadIntent(doc, { filename: 'report.docx', mimeType: '', sizeBytes: 90_000 }).ok,
    ).toBe(true);
  });

  it('still refuses a file whose extension is not allowed here', () => {
    const refused = validateUploadIntent(media, {
      filename: 'budget.pdf',
      mimeType: '',
      sizeBytes: 1000,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('image or video');
  });
});
