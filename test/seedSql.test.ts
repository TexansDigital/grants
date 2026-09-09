import { describe, it, expect } from 'vitest';
import { db } from './helpers';
import { emitSeedSql } from '../src/seed/emitSql';
import { newId } from '../src/lib/ids';
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
      'contact', 'organization', 'request', 'narrative', 'uploads', 'confirmation', 'optin',
    ]);

    // The artifact must satisfy the same gates a live publish does.
    expect(lintFormDefinition(def)).toEqual([]);
    expect(() => assertUniversalCoverage(allFields(def))).not.toThrow();
  });

  it('carries every field with its type, requiredness and promotion target intact', async () => {
    await applySeed();
    const def = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`));
    const fields = allFields(def);

    // By key, not by index: this program now has two stages, and an index
    // silently counted the wrong form's fields when the second was added.
    const appStage = INSPIRE_CHANGE.stages.find((st) => st.key === 'application')!;
    const specFieldCount = appStage.form.sections.reduce((n, s) => n + s.fields.length, 0);
    expect(fields).toHaveLength(specFieldCount);

    const amount = fields.find((f) => f.field_key === 'requested_amount')!;
    expect(amount.field_type).toBe('currency');
    expect(amount.is_required).toBe(true);
    expect(amount.maps_to).toBe('requested_amount_cents');
    // validation_json survived the round trip through SQL literals.
    expect(amount.validation.min_cents).toBe(1_000_000);

    const counties = fields.find((f) => f.field_key === 'counties_served')!;
    expect(counties.options.length).toBe(18);
  });

  it('pins the exact field keys of both forms, so a field cannot vanish', async () => {
    // A previous commit replaced a literal count with one derived from the
    // spec, and claimed that lost nothing. It did: deriving both sides from
    // INSPIRE_CHANGE means deleting a field from the spec changes expectation
    // and actual together, and the whole suite stays green. Verified by the
    // audit -- removing volunteer_engagement, contact_first_name, or the EIN
    // validation pattern was invisible to all 467 tests.
    //
    // The same reasoning the county list already carries: a question quietly
    // dropped from a live form is not something a reviewer will notice.
    await applySeed();

    const app = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`));
    expect(allFields(app).map((f) => f.field_key)).toEqual([
      'salutation', 'contact_first_name', 'contact_last_name', 'contact_email',
      'contact_phone', 'contact_job_title',
      'organization_name', 'ein', 'organization_website', 'organization_address',
      'mission_statement', 'annual_operating_budget',
      'project_title', 'requested_amount', 'funding_type', 'funding_type_other',
      'area_of_focus', 'counties_served', 'itemized_budget',
      'advancing_opportunity', 'project_summary', 'community_need',
      'implementation_timeline', 'individuals_benefiting', 'estimated_individuals_count',
      'leadership_lived_experience', 'partial_funding_plan', 'volunteer_engagement',
      'financial_statements', 'operating_budget_doc',
      'guidelines_attestation', 'marketing_opt_in',
    ]);

    const elig = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/eligibility/form`));
    expect(allFields(elig).map((f) => f.field_key)).toEqual([
      'entity_type_confirmation', 'guidelines_attestation', 'authorization_attestation',
      'organization_name', 'ein',
      // The two real disqualifiers, asked before any narrative.
      'requested_amount', 'counties_served',
      'contact_first_name', 'contact_last_name', 'contact_email',
    ]);

    // Validation that gates a real applicant is pinned per field, not counted.
    const eligEin = allFields(elig).find((f) => f.field_key === 'ein')!;
    expect(eligEin.validation.pattern).toBe('^\\D*(?:\\d\\D*){9}$');
    expect(eligEin.is_required).toBe(true);

    // The eligibility gates carry the SAME bounds as the application, or the
    // screen would pass someone the form then rejects.
    const eligAmount = allFields(elig).find((f) => f.field_key === 'requested_amount')!;
    const appAmount = allFields(app).find((f) => f.field_key === 'requested_amount')!;
    expect(eligAmount.validation.min_cents).toBe(appAmount.validation.min_cents);
    expect(eligAmount.validation.max_cents).toBe(appAmount.validation.max_cents);

    const eligCounties = allFields(elig).find((f) => f.field_key === 'counties_served')!;
    const appCounties = allFields(app).find((f) => f.field_key === 'counties_served')!;
    expect(eligCounties.options.map((o) => o.value)).toEqual(
      appCounties.options.map((o) => o.value),
    );
  });

  it('refuses a malformed promotion override, at insert and at update', async () => {
    // Both of migration 0009's triggers were entirely dead: nothing in the
    // suite ever wrote a bad required_maps_to_json, so deleting either one
    // left 467 tests green. That is the standard test/migrations.test.ts sets
    // for itself -- a constraint never exercised is a comment.
    await applySeed();
    const id = seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`);

    for (const bad of ['{"a":1}', 'not json', 'null', '42']) {
      await expect(
        db.prepare(`UPDATE form_definitions SET required_maps_to_json = ? WHERE id = ?`)
          .bind(bad, id).run(),
        `update accepted ${bad}`,
      ).rejects.toThrow(/must be a JSON array/);
    }

    await expect(
      db.prepare(
        `INSERT INTO form_definitions (id, program_id, form_key, stage_id, kind, name,
           version, status, required_maps_to_json, created_at, updated_at)
         SELECT ?, program_id, 'bad', stage_id, kind, name, 99, 'draft', '{"a":1}',
                created_at, updated_at FROM form_definitions WHERE id = ?`,
      ).bind(newId(), id).run(),
    ).rejects.toThrow(/must be a JSON array/);

    // A well-formed array is still accepted.
    await db.prepare(`UPDATE form_definitions SET required_maps_to_json = ? WHERE id = ?`)
      .bind('["ein"]', id).run();
  });

  it('preserves the conditional wiring, not just the rows', async () => {
    await applySeed();
    const def = await loadFormDefinition(db, seededId(`${INSPIRE_CHANGE.slug}/stage/application/form`));
    const fields = allFields(def);

    const parent = fields.find((f) => f.field_key === 'funding_type')!;
    const child = fields.find((f) => f.field_key === 'funding_type_other')!;

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
      .bind(seededId('quote-program/stage/eligibility/section/eligibility'))
      .first<{ title: string }>();
    expect(row?.title).toBe("Bob's \"eligibility\" section; DROP TABLE programs;--");

    // The injection attempt did not execute.
    const programs = await db.prepare(`SELECT COUNT(*) AS n FROM programs`).first<{ n: number }>();
    expect(programs!.n).toBeGreaterThan(0);
  });
});
