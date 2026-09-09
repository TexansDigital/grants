import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram, publishFormDefinition } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { validateSubmission, lintFormDefinition, allFields } from '../src/lib/forms';
import { loadFormDefinition } from '../src/lib/loadForm';
import { assertUniversalCoverage, assertNoDuplicateTargets } from '../src/lib/mapsTo';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { ProgramSpec } from '../src/seed/types';

const ctx = () => ctxFor(adminSession());

describe('published form definitions are immutable', () => {
  it('refuses to edit a field once published', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const formId = p.formDefinitionIds.application!;

    const field = await db
      .prepare(`SELECT id FROM form_fields WHERE form_definition_id = ? LIMIT 1`)
      .bind(formId)
      .first<{ id: string }>();

    await expect(
      db.prepare(`UPDATE form_fields SET label = 'Changed' WHERE id = ?`).bind(field!.id).run(),
    ).rejects.toThrow(/create a new version/);
  });

  it('refuses to add a field to a published form', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const formId = p.formDefinitionIds.application!;
    const section = await db
      .prepare(`SELECT id FROM form_sections WHERE form_definition_id = ? LIMIT 1`)
      .bind(formId)
      .first<{ id: string }>();

    await expect(
      db
        .prepare(
          `INSERT INTO form_fields (id, form_definition_id, form_section_id, field_key, label, field_type, is_required, sort_order, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(newId(), formId, section!.id, 'sneaky', 'Sneaky', 'short_text', 0, 99, nowIso())
        .run(),
    ).rejects.toThrow(/create a new version/);
  });

  it('refuses to delete a field from a published form', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const formId = p.formDefinitionIds.application!;
    const field = await db
      .prepare(`SELECT id FROM form_fields WHERE form_definition_id = ? LIMIT 1`)
      .bind(formId)
      .first<{ id: string }>();

    await expect(
      db.prepare(`DELETE FROM form_fields WHERE id = ?`).bind(field!.id).run(),
    ).rejects.toThrow(/create a new version/);
  });

  it('refuses to return a published definition to draft', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    await expect(
      db
        .prepare(`UPDATE form_definitions SET status='draft' WHERE id = ?`)
        .bind(p.formDefinitionIds.application!)
        .run(),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it('allows editing while still in draft', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE, { publish: false });
    const field = await db
      .prepare(`SELECT id FROM form_fields WHERE form_definition_id = ? LIMIT 1`)
      .bind(p.formDefinitionIds.application!)
      .first<{ id: string }>();
    await db.prepare(`UPDATE form_fields SET label = 'Edited' WHERE id = ?`).bind(field!.id).run();
    const row = await db.prepare(`SELECT label FROM form_fields WHERE id = ?`).bind(field!.id).first<{ label: string }>();
    expect(row?.label).toBe('Edited');
  });
});

describe('maps_to integrity', () => {
  it('the database refuses two fields claiming the same target', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE, { publish: false });
    const formId = p.formDefinitionIds.application!;
    const section = await db
      .prepare(`SELECT id FROM form_sections WHERE form_definition_id = ? LIMIT 1`)
      .bind(formId)
      .first<{ id: string }>();

    await expect(
      db
        .prepare(
          `INSERT INTO form_fields (id, form_definition_id, form_section_id, field_key, label, field_type, is_required, sort_order, maps_to, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(newId(), formId, section!.id, 'ein_again', 'EIN again', 'short_text', 0, 98, 'ein', nowIso())
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('the code produces a plain-language duplicate error before the constraint fires', () => {
    const dupes = [
      { maps_to: 'ein', label: 'EIN', id: '1', field_key: 'a' },
      { maps_to: 'ein', label: 'Tax ID', id: '2', field_key: 'b' },
    ] as any;
    // AppError.message is the INTERNAL message; publicMessage is what a human
    // is shown. Assert both, so the split cannot silently invert.
    try {
      assertNoDuplicateTargets(dupes);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('duplicate maps_to ein');
      expect(e.publicMessage).toContain('Two fields both claim "ein"');
      expect(e.publicMessage).toContain('Tax ID');
    }
  });

  it('refuses to publish a form that does not map the universal set', () => {
    const partial = [{ maps_to: 'ein' }, { maps_to: 'organization_name' }] as any;
    try {
      assertUniversalCoverage(partial);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('requested_amount_cents');
      expect(e.publicMessage).toContain('cannot be published');
    }
  });

  it('Inspire Change maps the full universal set', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    expect(() => assertUniversalCoverage(allFields(def))).not.toThrow();
  });
});

describe('form loading and validation', () => {
  it('loads sections and fields in order with parsed options and validation', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);

    expect(def.status).toBe('published');
    expect(def.sections.map((s) => s.section_key)).toEqual([
      'eligibility', 'contact', 'organization', 'request', 'narrative', 'uploads', 'optin',
    ]);

    const counties = allFields(def).find((f) => f.field_key === 'counties_served')!;
    // Exact: this list is the program's eligibility boundary, so a county
    // quietly dropped from it silently makes real applicants ineligible.
    expect(counties.options.length).toBe(18);
    expect(counties.options[0]).toHaveProperty('label');

    const amount = allFields(def).find((f) => f.field_key === 'requested_amount')!;
    expect(amount.validation.min_cents).toBe(1_000_000);
    expect(amount.validation.max_cents).toBe(5_000_000);
  });

  it('lists every missing required field at once, not one at a time', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const outcome = validateSubmission(def, {});
    // An applicant on the review screen needs the whole list with anchors,
    // not a single error that reappears eight times.
    expect(outcome.errors.length).toBeGreaterThan(15);
    expect(outcome.errors.every((e) => typeof e.field === 'string' && e.message.length > 0)).toBe(true);
    expect(outcome.errors.some((e) => e.section === 'Narrative')).toBe(true);
  });

  it('treats an unchecked required attestation as an explicit failure', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const outcome = validateSubmission(def, { entity_type_confirmation: false });
    const err = outcome.errors.find((e) => e.field === 'entity_type_confirmation');
    expect(err?.message).toContain('You must confirm');
  });

  it('does not require a hidden conditional field', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);

    // funding_type_other is required, but ONLY when funding_type is 'other'.
    const notOther = validateSubmission(def, { funding_type: 'programs' });
    expect(notOther.errors.some((e) => e.field === 'funding_type_other')).toBe(false);

    const isOther = validateSubmission(def, { funding_type: 'other' });
    expect(isOther.errors.some((e) => e.field === 'funding_type_other')).toBe(true);
  });

  it('discards an answer to a field that is no longer visible', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const otherField = allFields(def).find((f) => f.field_key === 'funding_type_other')!;

    // Applicant picked "other", typed a detail, then changed their mind. The
    // stale detail must not ship.
    const outcome = validateSubmission(def, {
      funding_type: 'programs',
      funding_type_other: 'Stale answer from before',
    });
    expect(outcome.hiddenFieldIds).toContain(otherField.id);
    expect(outcome.answers.has(otherField.id)).toBe(false);
  });

  it('partial mode lets a half-finished draft save without required errors', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const outcome = validateSubmission(def, { contact_first_name: 'Alex' }, { partial: true });
    expect(outcome.errors).toHaveLength(0);
  });

  it('partial mode still reports a type error immediately', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const outcome = validateSubmission(def, { requested_amount: 'twenty thousand' }, { partial: true });
    expect(outcome.errors.some((e) => e.field === 'requested_amount')).toBe(true);
  });
});

describe('form definition lint', () => {
  it('passes a well-formed program', async () => {
    const p = await seedProgram(db, ctx(), INSPIRE_CHANGE);
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    expect(lintFormDefinition(def)).toEqual([]);
  });

  it('catches a select with no options and a dangling conditional', () => {
    const def: any = {
      id: 'd', program_id: 'p', stage_id: 's', kind: 'application', name: 'n', version: 1, status: 'draft',
      sections: [
        {
          id: 's1', section_key: 'a', title: 'A', description: null, sort_order: 0,
          fields: [
            { id: 'f1', field_key: 'empty_select', label: 'Empty', field_type: 'select', is_required: false, sort_order: 0, options: [], validation: {}, conditional_on_field_id: null, conditional_value: null, maps_to: null, section_id: 's1' },
            { id: 'f2', field_key: 'orphan', label: 'Orphan', field_type: 'short_text', is_required: false, sort_order: 1, options: [], validation: {}, conditional_on_field_id: 'does-not-exist', conditional_value: 'x', maps_to: null, section_id: 's1' },
          ],
        },
      ],
    };
    const problems = lintFormDefinition(def);
    expect(problems.some((p) => p.includes('no options'))).toBe(true);
    expect(problems.some((p) => p.includes('not in this form'))).toBe(true);
  });
});

describe('seeder rejects an invalid program before writing anything', () => {
  it('refuses a spec missing universal maps_to coverage', async () => {
    const bad: ProgramSpec = {
      slug: 'incomplete', name: 'Incomplete', description: 'x', fiscalYear: 2026,
      totalBudgetCents: 100, compliancePolicy: 'ignore', guidelinesVersion: 'v1',
      stages: [{
        key: 'only', name: 'Only',
        form: { name: 'Form', sections: [{ key: 's', title: 'S', fields: [
          { key: 'name', label: 'Name', type: 'short_text', mapsTo: 'organization_name' },
        ] }] },
      }],
      cycles: [],
    };
    await expect(seedProgram(db, ctx(), bad)).rejects.toThrow(
      /missing universal maps_to targets/,
    );

    // And nothing was written: the pre-flight runs before the batch.
    const leftover = await db
      .prepare(`SELECT COUNT(*) AS n FROM programs WHERE slug = 'incomplete'`)
      .first<{ n: number }>();
    expect(leftover?.n).toBe(0);
  });
});
