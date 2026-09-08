import { describe, it, expect } from 'vitest';
import { db } from './helpers';
import { emitSeedSql } from '../src/seed/emitSql';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seededId } from '../src/seed/deterministicIds';
import { allFields, lintFormDefinition } from '../src/lib/forms';
import { loadFormDefinition } from '../src/lib/loadForm';
import { assertUniversalCoverage } from '../src/lib/mapsTo';

/**
 * The seed artifact is what actually populates a real database, so it is tested
 * by EXECUTING it, not by inspecting the string. Everything asserted here is
 * read back through the same `loadFormDefinition` the application uses.
 */

const NOW = '2026-01-01T00:00:00.000Z';

/** Split the artifact into executable statements, dropping comments and blanks. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--'))
    .map((l) => l.replace(/;$/, ''));
}

async function applySeed(): Promise<string[]> {
  const sql = await emitSeedSql(INSPIRE_CHANGE, { now: NOW });
  const statements = statementsOf(sql);
  for (const s of statements) {
    await db.prepare(s).run();
  }
  return statements;
}

describe('seed artifact', () => {
  it('executes cleanly against a freshly migrated database', async () => {
    const statements = await applySeed();
    expect(statements.length).toBeGreaterThan(80);

    const program = await db
      .prepare(`SELECT id, name, slug, compliance_policy, required_maps_to_json FROM programs WHERE slug = ?`)
      .bind(INSPIRE_CHANGE.slug)
      .first<{ id: string; name: string; slug: string; compliance_policy: string; required_maps_to_json: string }>();

    expect(program?.name).toBe('Inspire Change');
    expect(program?.compliance_policy).toBe('warn');
    expect(JSON.parse(program!.required_maps_to_json)).toContain('ein');
  });

  it('produces a PUBLISHED form that loads and lints exactly like a live one', async () => {
    await applySeed();

    const formId = seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`);
    const def = await loadFormDefinition(db, formId);

    expect(def.status).toBe('published');
    expect(def.sections.map((s) => s.section_key)).toEqual([
      'eligibility', 'contact', 'organization', 'request', 'narrative', 'uploads', 'optin',
    ]);

    // The artifact must satisfy the same gates a live publish does.
    expect(lintFormDefinition(def)).toEqual([]);
    expect(() => assertUniversalCoverage(allFields(def))).not.toThrow();
  });

  it('carries every field with its type, requiredness and promotion target intact', async () => {
    await applySeed();
    const def = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`));
    const fields = allFields(def);

    const specFieldCount = INSPIRE_CHANGE.stages[0]!.form.sections.reduce(
      (n, s) => n + s.fields.length, 0);
    expect(fields).toHaveLength(specFieldCount);

    const amount = fields.find((f) => f.field_key === 'requested_amount')!;
    expect(amount.field_type).toBe('currency');
    expect(amount.is_required).toBe(true);
    expect(amount.maps_to).toBe('requested_amount_cents');
    // validation_json survived the round trip through SQL literals.
    expect(amount.validation.min_cents).toBe(500_000);

    const counties = fields.find((f) => f.field_key === 'counties_served')!;
    expect(counties.options.length).toBeGreaterThan(5);
  });

  it('preserves the conditional wiring, not just the rows', async () => {
    await applySeed();
    const def = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`));
    const fields = allFields(def);

    const parent = fields.find((f) => f.field_key === 'area_of_focus')!;
    const child = fields.find((f) => f.field_key === 'area_of_focus_other')!;

    // A dangling conditional would still insert fine but silently break the
    // form, so the pointer is asserted rather than assumed.
    expect(child.conditional_on_field_id).toBe(parent.id);
    expect(child.conditional_value).toBe('other');
  });

  it('writes audit rows for the seeded configuration', async () => {
    await applySeed();
    const { results } = await db
      .prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action`)
      .all<{ action: string }>();
    const actions = new Set(results.map((r) => r.action));

    for (const a of ['program.created', 'program_stage.created', 'form_definition.created',
                     'form_section.created', 'form_field.created', 'cycle.created',
                     'form_definition.published']) {
      expect(actions, `seed artifact missing audit action ${a}`).toContain(a);
    }
  });

  it('REFUSES to run twice, so a seed cannot be silently duplicated', async () => {
    await applySeed();

    // Nothing is hard-deleted and audit_log is append-only, so a duplicated
    // seed would be permanent. Deterministic ids make the second run collide.
    await expect(applySeed()).rejects.toBeTruthy();

    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM programs WHERE slug = ?`)
      .bind(INSPIRE_CHANGE.slug)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('is byte-stable across regenerations, so it can be reviewed as a diff', async () => {
    const a = await emitSeedSql(INSPIRE_CHANGE, { now: NOW });
    const b = await emitSeedSql(INSPIRE_CHANGE, { now: NOW });

    // audit_log ids are random by design; everything else must match exactly.
    const strip = (s: string) => s.replace(/INSERT INTO audit_log \(id[^\n]*/g, '[audit]');
    expect(strip(a)).toBe(strip(b));
  });

  it('refuses to emit a float where integer cents are required', async () => {
    const broken = {
      ...INSPIRE_CHANGE,
      slug: 'float-program',
      totalBudgetCents: 1234.56,
    };
    await expect(emitSeedSql(broken, { now: NOW })).rejects.toThrow(/non-integer/);
  });

  it('escapes SQL-hostile content in labels rather than breaking the artifact', async () => {
    const spec = {
      ...INSPIRE_CHANGE,
      slug: 'quote-program',
      stages: [
        {
          ...INSPIRE_CHANGE.stages[0]!,
          form: {
            ...INSPIRE_CHANGE.stages[0]!.form,
            sections: INSPIRE_CHANGE.stages[0]!.form.sections.map((s, i) =>
              i === 0
                ? { ...s, title: "Bob's \"eligibility\" section; DROP TABLE programs;--" }
                : s,
            ),
          },
        },
      ],
    };
    const sql = await emitSeedSql(spec, { now: NOW });
    for (const s of statementsOf(sql)) await db.prepare(s).run();

    const row = await db
      .prepare(`SELECT title FROM form_sections WHERE id = ?`)
      .bind(seededId('quote-program/stage/application/section/eligibility'))
      .first<{ title: string }>();
    expect(row?.title).toBe("Bob's \"eligibility\" section; DROP TABLE programs;--");

    // The injection attempt did not execute.
    const programs = await db.prepare(`SELECT COUNT(*) AS n FROM programs`).first<{ n: number }>();
    expect(programs!.n).toBeGreaterThan(0);
  });
});
