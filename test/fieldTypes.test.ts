import { describe, it, expect } from 'vitest';
import { coerceAnswer, validateUploadIntent, type FieldDef, type FieldType } from '../src/lib/fieldTypes';

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
  'checkbox_attestation', 'currency', 'integer', 'url', 'address_block',
  'file_upload', 'consent_checkbox', 'other_specify',
];

describe('field type registry', () => {
  it('handles every one of the fourteen required types', () => {
    expect(ALL_TYPES).toHaveLength(14);
    for (const t of ALL_TYPES) {
      const f = field({
        field_type: t,
        options: [{ value: 'a', label: 'A' }],
      });
      // Blank is the normal state on most fields and must degrade gracefully.
      const blank = coerceAnswer(f, '');
      expect(blank.ok, `${t} should accept blank`).toBe(true);
      if (blank.ok) expect(blank.empty).toBe(true);
    }
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
