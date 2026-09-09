import { describe, it, expect } from 'vitest';
import { displayValue, readBackLines } from '../src/lib/answerDisplay';
import { EMPTY_VALUE, type FieldDef, type FieldType, type StoredValue } from '../src/lib/fieldTypes';
import type { FormDefinition } from '../src/lib/forms';

const field = (type: FieldType, over: Partial<FieldDef> = {}): FieldDef => ({
  id: `f-${type}`,
  field_key: type,
  label: `A ${type}`,
  field_type: type,
  is_required: false,
  sort_order: 1,
  options: [],
  validation: {},
  conditional_on_field_id: null,
  conditional_value: null,
  maps_to: null,
  section_id: 's1',
  ...over,
});

const stored = (over: Partial<StoredValue>): StoredValue => ({ ...EMPTY_VALUE, ...over });

describe('one answer, as a person reads it', () => {
  it('renders every field type the engine supports', () => {
    const cases: Array<[FieldDef, StoredValue, string]> = [
      [field('short_text'), stored({ value_text: 'Bayou Reach' }), 'Bayou Reach'],
      [field('long_text'), stored({ value_text: 'A paragraph.' }), 'A paragraph.'],
      [field('other_specify'), stored({ value_text: 'Capacity building' }), 'Capacity building'],
      [field('email'), stored({ value_text: 'grants@example.org' }), 'grants@example.org'],
      [field('url'), stored({ value_text: 'https://example.org' }), 'https://example.org'],
      [field('phone'), stored({ value_text: '7135550123' }), '713-555-0123'],
      [
        field('select', { options: [{ value: 'program', label: 'Program support' }] }),
        stored({ value_text: 'program' }),
        'Program support',
      ],
      [
        field('multi_select', {
          options: [
            { value: 'harris', label: 'Harris' },
            { value: 'fort_bend', label: 'Fort Bend' },
          ],
        }),
        stored({ value_json: JSON.stringify(['fort_bend', 'harris']) }),
        'Fort Bend, Harris',
      ],
      [field('checkbox_attestation'), stored({ value_int: 1 }), 'Yes'],
      [field('consent_checkbox'), stored({ value_int: 0 }), 'No'],
      [field('integer'), stored({ value_int: 12500 }), '12,500'],
      [
        field('address_block'),
        stored({
          value_json: JSON.stringify({
            address_1: '2 NRG Park',
            city: 'Houston',
            state: 'TX',
            postal_code: '77054',
          }),
        }),
        '2 NRG Park, Houston, TX, 77054',
      ],
      [
        field('file_upload'),
        stored({
          value_json: JSON.stringify([
            { attachment_id: 'a1', filename: 'budget.pdf' },
            { attachment_id: 'a2', filename: 'audit.pdf' },
          ]),
        }),
        'budget.pdf, audit.pdf',
      ],
    ];
    for (const [f, v, expected] of cases) {
      expect(displayValue(f, v), f.field_type).toBe(expected);
    }
  });

  it('formats currency as dollars, from integer cents, only here', () => {
    // The display edge. $19,999.99 keeps its cents; a round figure does not
    // grow a trailing .00 that nobody writes on a grant application.
    expect(displayValue(field('currency'), stored({ value_int: 1_999_999 }))).toBe('$19,999.99');
    expect(displayValue(field('currency'), stored({ value_int: 2_500_000 }))).toBe('$25,000');
  });

  it('gives an unanswered field no line at all', () => {
    for (const t of ['short_text', 'currency', 'multi_select', 'file_upload'] as FieldType[]) {
      expect(displayValue(field(t), stored({})), t).toBeNull();
      expect(displayValue(field(t), undefined), t).toBeNull();
    }
  });

  it('distinguishes an unchecked attestation from an unanswered one', () => {
    // value_int 0 is an answer -- the applicant said no. Collapsing the two
    // would turn a declined attestation into a silent omission.
    expect(displayValue(field('consent_checkbox'), stored({ value_int: 0 }))).toBe('No');
    expect(displayValue(field('consent_checkbox'), stored({}))).toBeNull();
  });

  it('falls back to the stored value when an option label is missing', () => {
    expect(displayValue(field('select', { options: [] }), stored({ value_text: 'program' })))
      .toBe('program');
  });

  it('survives malformed json rather than throwing at an applicant', () => {
    expect(displayValue(field('multi_select'), stored({ value_json: '{oh no' }))).toBeNull();
    expect(displayValue(field('file_upload'), stored({ value_json: '[{"nope":1}]' }))).toBeNull();
  });

  it('survives json that parses but is the wrong shape', () => {
    // JSON.parse('null') SUCCEEDS and returns null, so a try/catch alone lets
    // it through and the next line reads a property off null. Each of these
    // is valid JSON of a shape the branch cannot use.
    for (const raw of ['null', '"a string"', '42', '{"not":"an array"}']) {
      expect(displayValue(field('multi_select'), stored({ value_json: raw })), raw).toBeNull();
      expect(displayValue(field('file_upload'), stored({ value_json: raw })), raw).toBeNull();
    }
    for (const raw of ['null', '"a string"', '42', '["not","an object"]']) {
      expect(displayValue(field('address_block'), stored({ value_json: raw })), raw).toBeNull();
    }
  });

  it('never puts an attachment id or an object key in the read-back', () => {
    const out = displayValue(
      field('file_upload'),
      stored({ value_json: JSON.stringify([{ attachment_id: 'secret-id-99', filename: 'a.pdf' }]) }),
    );
    expect(out).toBe('a.pdf');
    expect(out).not.toContain('secret-id-99');
  });
});

describe('the whole submission, in the order it was asked', () => {
  const definition = (): FormDefinition => ({
    id: 'fd1',
    program_id: 'p1',
    stage_id: 'st1',
    kind: 'application',
    name: 'Test',
    version: 1,
    status: 'published',
    sections: [
      {
        id: 's2',
        section_key: 'request',
        title: 'Your request',
        description: null,
        sort_order: 2,
        fields: [
          field('currency', { id: 'amount', sort_order: 2, label: 'Amount', section_id: 's2' }),
          field('short_text', { id: 'title', sort_order: 1, label: 'Project', section_id: 's2' }),
        ],
      },
      {
        id: 's1',
        section_key: 'org',
        title: 'Organization',
        description: null,
        sort_order: 1,
        fields: [field('short_text', { id: 'name', sort_order: 1, label: 'Name', section_id: 's1' })],
      },
    ],
  });

  it('sorts sections and fields, ignoring the order they arrived in', () => {
    const answers = new Map<string, StoredValue>([
      ['name', stored({ value_text: 'Bayou Reach' })],
      ['title', stored({ value_text: 'Reading Rockets' })],
      ['amount', stored({ value_int: 2_500_000 })],
    ]);
    expect(readBackLines(definition(), answers)).toEqual([
      { section: 'Organization', label: 'Name', value: 'Bayou Reach' },
      { section: 'Your request', label: 'Project', value: 'Reading Rockets' },
      { section: 'Your request', label: 'Amount', value: '$25,000' },
    ]);
  });

  it('omits empty answers, and a section whose fields are all empty', () => {
    const answers = new Map<string, StoredValue>([['name', stored({ value_text: 'Bayou Reach' })]]);
    const lines = readBackLines(definition(), answers);
    expect(lines).toEqual([{ section: 'Organization', label: 'Name', value: 'Bayou Reach' }]);
    // No dangling label, and no heading for a section with nothing under it.
    expect(lines.some((l) => l.section === 'Your request')).toBe(false);
  });

  it('is empty, not broken, for an application with no answers', () => {
    expect(readBackLines(definition(), new Map())).toEqual([]);
  });
});
