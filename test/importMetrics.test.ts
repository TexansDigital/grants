import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { parseMetricsCsv } from '../src/import/metrics';
import { planMetricImport, applyMetricImport, retireMetrics } from '../src/import/importMetrics';
import { buildReportForm } from '../src/lib/reportForm';

const HEADER = 'metric_key,label,help_text,metric_type,unit,is_required,sort_order,promotes_to';
const file = (...rows: string[]) => {
  const r = parseMetricsCsv([HEADER, ...rows].join('\n'));
  if (!r.ok) throw new Error(`fixture does not parse: ${JSON.stringify(r.issues)}`);
  return r.metrics;
};

const SERVED = 'individuals_served,How many individuals?,,integer,people,yes,10,';
const SPENT = 'funds_spent,How much has been spent?,,currency,,yes,20,funds_spent_cents';
const HOURS = 'volunteer_hours,Volunteer hours,,decimal,hours,no,30,';

let seq = 0;
async function program() {
  const ctx = ctxFor(adminSession());
  const p = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `im-${++seq}` });
  return { programId: p.programId, ctx };
}

async function importFile(p: { programId: string; ctx: ReturnType<typeof ctxFor> }, ...rows: string[]) {
  const plan = await planMetricImport(db, p.programId, file(...rows));
  return { plan, result: await applyMetricImport(db, p.ctx, p.programId, plan) };
}

async function metricsOf(programId: string) {
  const { results } = await db.prepare(
    `SELECT metric_key, label, metric_type, unit, is_required, sort_order, status, promotes_to
       FROM metric_definitions WHERE program_id=? ORDER BY sort_order, metric_key`,
  ).bind(programId).all<Record<string, unknown>>();
  return results;
}

// ---------------------------------------------------------------------------
describe('the first import', () => {
  it('creates every metric in the file', async () => {
    const p = await program();
    const { result } = await importFile(p, SERVED, SPENT, HOURS);
    expect(result).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    expect(await metricsOf(p.programId)).toEqual([
      { metric_key: 'individuals_served', label: 'How many individuals?',
        metric_type: 'integer', unit: 'people', is_required: 1, sort_order: 10,
        status: 'active', promotes_to: null },
      { metric_key: 'funds_spent', label: 'How much has been spent?',
        metric_type: 'currency', unit: null, is_required: 1, sort_order: 20,
        status: 'active', promotes_to: 'funds_spent_cents' },
      { metric_key: 'volunteer_hours', label: 'Volunteer hours',
        metric_type: 'decimal', unit: 'hours', is_required: 0, sort_order: 30,
        status: 'active', promotes_to: null },
    ]);
  });

  it('audits each metric it creates', async () => {
    const p = await program();
    await importFile(p, SERVED, SPENT);
    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log a
        WHERE a.action='metric_definition.created'
          AND a.entity_id IN (SELECT id FROM metric_definitions WHERE program_id=?)`,
    ).bind(p.programId).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it('refuses a program that does not exist', async () => {
    await expect(planMetricImport(db, 'nope', file(SERVED))).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

// ---------------------------------------------------------------------------
describe('running the same file again, which is the normal case', () => {
  it('changes nothing and says so', async () => {
    const p = await program();
    await importFile(p, SERVED, SPENT);
    const { result } = await importFile(p, SERVED, SPENT);
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await metricsOf(p.programId)).toHaveLength(2);
  });

  it('applies a reworded question without touching the identity', async () => {
    const p = await program();
    await importFile(p, SERVED);
    const { plan, result } = await importFile(
      p, 'individuals_served,How many people did this reach?,Unique people.,integer,people,yes,10,',
    );
    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(plan.rows[0]).toMatchObject({ kind: 'update', changes: ['label', 'help_text'] });
    const [row] = await metricsOf(p.programId);
    expect(row).toMatchObject({
      metric_key: 'individuals_served', label: 'How many people did this reach?',
    });
  });

  it('records which fields changed, not what they said', async () => {
    const p = await program();
    await importFile(p, SERVED);
    await importFile(p, 'individuals_served,Reworded entirely,,integer,people,yes,10,');
    const row = await db.prepare(
      `SELECT before_json, after_json FROM audit_log WHERE action='metric_definition.updated'`,
    ).first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(row!.before_json)).toEqual({ changed: ['label'] });
    expect(row!.after_json).not.toContain('Reworded entirely');
  });

  it('reorders the questions when the spreadsheet reorders them', async () => {
    const p = await program();
    await importFile(p, SERVED, HOURS);
    const { result } = await importFile(
      p,
      'volunteer_hours,Volunteer hours,,decimal,hours,no,5,',
      'individuals_served,How many individuals?,,integer,people,yes,40,',
    );
    expect(result.updated).toBe(2);
    expect((await metricsOf(p.programId)).map((m) => m.metric_key))
      .toEqual(['volunteer_hours', 'individuals_served']);
  });

  it('adds a metric partway through a program without disturbing the others', async () => {
    const p = await program();
    await importFile(p, SERVED, SPENT);
    const { result } = await importFile(p, SERVED, SPENT, HOURS);
    expect(result).toMatchObject({ created: 1, unchanged: 2 });
    expect((await metricsOf(p.programId)).map((m) => m.metric_key))
      .toEqual(['individuals_served', 'funds_spent', 'volunteer_hours']);
  });
});

// ---------------------------------------------------------------------------
describe('the type, which a re-import may never change', () => {
  it('blocks a metric whose type the file has changed', async () => {
    const p = await program();
    await importFile(p, SERVED);
    const plan = await planMetricImport(
      db, p.programId,
      file('individuals_served,How many individuals?,,text,,yes,10,'),
    );
    expect(plan.ok).toBe(false);
    expect(plan.rows[0]).toMatchObject({ kind: 'blocked' });
    expect((plan.rows[0] as { reason: string }).reason).toContain('Retire it');
  });

  it('writes nothing at all when any row is blocked', async () => {
    // The whole file or none of it. A half-applied configuration change means
    // a form scaffolded from half a spreadsheet.
    const p = await program();
    await importFile(p, SERVED);
    const plan = await planMetricImport(db, p.programId, file(
      'individuals_served,How many individuals?,,text,,yes,10,',
      HOURS,
    ));
    const err = await appErrorFrom(applyMetricImport(db, p.ctx, p.programId, plan));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect((await metricsOf(p.programId)).map((m) => m.metric_key))
      .toEqual(['individuals_served']);
  });

  it('blocks it even before any value has been reported', async () => {
    // The database only refuses a type change once values exist. By then the
    // report form has already been built around the old type, and the failure
    // surfaces as a constraint violation nobody can read.
    const p = await program();
    await importFile(p, HOURS);
    const plan = await planMetricImport(
      db, p.programId, file('volunteer_hours,Volunteer hours,,integer,hours,no,30,'),
    );
    expect(plan.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('moving the funds-spent claim', () => {
  it('moves it between metrics regardless of the order of the rows', async () => {
    // The unique index permits one claimant per program, so writing the new
    // claimant before clearing the old one fails. Which row the spreadsheet
    // lists first should not decide whether an import works.
    const p = await program();
    await importFile(p, SPENT, 'other_spend,How much else?,,currency,,no,30,');
    const { result } = await importFile(
      p,
      'funds_spent,How much has been spent?,,currency,,yes,20,',
      'other_spend,How much else?,,currency,,no,30,funds_spent_cents',
    );
    expect(result.updated).toBe(2);
    const rows = await metricsOf(p.programId);
    expect(rows.find((r) => r.metric_key === 'funds_spent')!.promotes_to).toBeNull();
    expect(rows.find((r) => r.metric_key === 'other_spend')!.promotes_to)
      .toBe('funds_spent_cents');
  });

  it('moves it even when the new claimant is listed first', async () => {
    // The order the two rows appear in decided whether this worked, which is
    // a property no spreadsheet author could be expected to know about.
    const p = await program();
    await importFile(p, SPENT, 'other_spend,How much else?,,currency,,no,30,');
    const { result } = await importFile(
      p,
      'other_spend,How much else?,,currency,,no,15,funds_spent_cents',
      'funds_spent,How much has been spent?,,currency,,yes,20,',
    );
    expect(result.updated).toBe(2);
    const rows = await metricsOf(p.programId);
    expect(rows.find((r) => r.metric_key === 'other_spend')!.promotes_to)
      .toBe('funds_spent_cents');
    expect(rows.find((r) => r.metric_key === 'funds_spent')!.promotes_to).toBeNull();
  });

  it('drops the claim when the file stops making it', async () => {
    const p = await program();
    await importFile(p, SPENT);
    await importFile(p, 'funds_spent,How much has been spent?,,currency,,yes,20,');
    const [row] = await metricsOf(p.programId);
    expect(row!.promotes_to).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('a metric the file does not mention', () => {
  it('is reported, never removed', async () => {
    // Far more often a column somebody forgot to paste than a decision to stop
    // asking, and the cost of guessing wrong is a question silently dropped.
    const p = await program();
    await importFile(p, SERVED, HOURS);
    const { result } = await importFile(p, SERVED);
    expect(result.missingFromFile).toEqual(['volunteer_hours']);
    const rows = await metricsOf(p.programId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.metric_key === 'volunteer_hours')!.status).toBe('active');
  });

  it('is retired only by a separate deliberate act', async () => {
    const p = await program();
    await importFile(p, SERVED, HOURS);
    expect(await retireMetrics(db, p.ctx, p.programId, ['volunteer_hours'])).toBe(1);
    const rows = await metricsOf(p.programId);
    expect(rows.find((r) => r.metric_key === 'volunteer_hours')!.status).toBe('retired');
    // Retired, not deleted. Every value ever reported against it hangs off
    // this row.
    expect(rows).toHaveLength(2);
  });

  it('audits a retirement with both sides of it', async () => {
    const p = await program();
    await importFile(p, HOURS);
    await retireMetrics(db, p.ctx, p.programId, ['volunteer_hours']);
    const row = await db.prepare(
      `SELECT before_json, after_json FROM audit_log WHERE action='metric_definition.retired'`,
    ).first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(row!.before_json)).toEqual({ status: 'active' });
    expect(JSON.parse(row!.after_json)).toMatchObject({ status: 'retired' });
  });

  it('ignores a retirement for a metric that is not there', async () => {
    const p = await program();
    await importFile(p, SERVED);
    expect(await retireMetrics(db, p.ctx, p.programId, ['never_existed'])).toBe(0);
    expect(await retireMetrics(db, p.ctx, p.programId, [])).toBe(0);
  });

  it('brings a retired metric back when the file asks for it again', async () => {
    const p = await program();
    await importFile(p, SERVED, HOURS);
    await retireMetrics(db, p.ctx, p.programId, ['volunteer_hours']);
    const { plan, result } = await importFile(p, SERVED, HOURS);
    expect(result.updated).toBe(1);
    expect((plan.rows.find((r) => r.kind === 'update') as { changes: string[] }).changes)
      .toContain('status');
    const rows = await metricsOf(p.programId);
    expect(rows.find((r) => r.metric_key === 'volunteer_hours')!.status).toBe('active');
  });

  it('does not list a retired metric as missing from the next file', async () => {
    const p = await program();
    await importFile(p, SERVED, HOURS);
    await retireMetrics(db, p.ctx, p.programId, ['volunteer_hours']);
    const { result } = await importFile(p, SERVED);
    expect(result.missingFromFile).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('end to end, from a spreadsheet to a report form', () => {
  it('imports a file and scaffolds the questions it describes', async () => {
    const p = await program();
    await importFile(p, SERVED, SPENT, HOURS);
    const form = await buildReportForm(db, p.ctx, { programId: p.programId });

    const { results } = await db.prepare(
      `SELECT ff.field_key, ff.field_type, ff.is_required, ff.validation_json
         FROM form_fields ff
        WHERE ff.form_definition_id=? AND ff.metric_definition_id IS NOT NULL
        ORDER BY ff.sort_order`,
    ).bind(form.formDefinitionId).all<Record<string, unknown>>();

    expect(results.map((r) => r.field_key)).toEqual([
      'metric_individuals_served', 'metric_funds_spent', 'metric_volunteer_hours',
    ]);
    expect(results.map((r) => r.field_type)).toEqual(['integer', 'currency', 'decimal']);
    expect(results.map((r) => r.is_required)).toEqual([1, 1, 0]);
    // The unit from the spreadsheet reaches the grantee's screen.
    expect(JSON.parse(results[2]!.validation_json as string))
      .toMatchObject({ unit_label: 'hours' });
  });

  it('leaves a retired metric out of the next version of the form', async () => {
    const p = await program();
    await importFile(p, SERVED, HOURS);
    await retireMetrics(db, p.ctx, p.programId, ['volunteer_hours']);
    const form = await buildReportForm(db, p.ctx, { programId: p.programId });
    const { results } = await db.prepare(
      `SELECT field_key FROM form_fields
        WHERE form_definition_id=? AND metric_definition_id IS NOT NULL`,
    ).bind(form.formDefinitionId).all<{ field_key: string }>();
    expect(results.map((r) => r.field_key)).toEqual(['metric_individuals_served']);
  });
});
