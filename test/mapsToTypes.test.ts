import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { loadFormDefinition, assertPublishable } from '../src/lib/loadForm';
import { mapsToTypeProblems } from '../src/lib/mapsTo';
import type { FieldDef } from '../src/lib/fieldTypes';

/**
 * The publish gate that stops a silent 100x money error.
 *
 * A short_text field mapped to requested_amount_cents promotes its value_text.
 * assertCents is skipped because the value is a string, and SQLite's
 * TEXT->INTEGER affinity converts "25000" to the integer 25000 before the
 * column's CHECK runs -- so the CHECK passes and a $25,000 request is stored as
 * $250.00 with nothing to indicate anything went wrong.
 */

function field(over: Partial<FieldDef>): FieldDef {
  return {
    id: 'f1', field_key: 'k', label: 'A field', field_type: 'short_text',
    is_required: true, sort_order: 0, options: [], validation: {},
    conditional_on_field_id: null, conditional_value: null, maps_to: null,
    section_id: 's1', ...over,
  };
}

describe('maps_to type gate', () => {
  it('rejects a text field promoting into a money column', async () => {
    const problems = mapsToTypeProblems([
      field({ label: 'Grant request amount', field_type: 'short_text', maps_to: 'requested_amount_cents' }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/short_text.*requested_amount_cents.*requires currency/);
  });

  it('rejects an integer field promoting into a money column', async () => {
    // Integer is the near-miss that looks safest and is not: it stores whole
    // dollars into a cents column.
    const problems = mapsToTypeProblems([
      field({ field_type: 'integer', maps_to: 'annual_operating_budget_cents' }),
    ]);
    expect(problems).toHaveLength(1);
  });

  it('accepts a currency field promoting into a money column', () => {
    expect(
      mapsToTypeProblems([field({ field_type: 'currency', maps_to: 'requested_amount_cents' })]),
    ).toEqual([]);
  });

  it('guards the identity and contact targets too', () => {
    expect(mapsToTypeProblems([field({ field_type: 'long_text', maps_to: 'ein' })])).toHaveLength(1);
    expect(mapsToTypeProblems([field({ field_type: 'short_text', maps_to: 'primary_contact_email' })])).toHaveLength(1);
    expect(mapsToTypeProblems([field({ field_type: 'short_text', maps_to: 'counties_served' })])).toHaveLength(1);
  });

  it('rejects an unknown target rather than ignoring it', () => {
    expect(mapsToTypeProblems([field({ maps_to: 'not_a_target' })])[0]).toMatch(/unknown target/);
  });

  it('leaves a field with no maps_to alone', () => {
    expect(mapsToTypeProblems([field({ maps_to: null })])).toEqual([]);
  });

  it('the SEEDED Inspire Change form passes the gate', async () => {
    // The real form must survive its own publish check, or the gate is wrong.
    const p = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    expect(() => assertPublishable(def)).not.toThrow();
  });

  it('assertPublishable REFUSES a definition with a mis-mapped money field', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    for (const section of def.sections) {
      for (const f of section.fields) {
        if (f.maps_to === 'requested_amount_cents') f.field_type = 'short_text';
      }
    }
    try {
      assertPublishable(def);
      expect.unreachable('a mis-mapped money field must not publish');
    } catch (e: any) {
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.publicMessage).toBe('This form cannot be published yet.');
      // The problem reaches the admin as a sentence naming the field.
      expect(JSON.stringify(e.fieldErrors)).toMatch(/requires currency/);
    }
  });
});
