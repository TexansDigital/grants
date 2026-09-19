import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  buildReportForm, planReportForm, metricToField, loadMetricDefinitions,
  DEFAULT_REPORT_NARRATIVE, FIELD_TYPE_BY_METRIC_TYPE, METRIC_FIELD_PREFIX, publishReportForm,
  SCAFFOLDED_TEXT_MAX_LENGTH, type MetricDefinition,
} from '../src/lib/reportForm';
import { loadFormDefinition } from '../src/lib/loadForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { submitReport } from '../src/lib/reportSubmit';
import { allFields, validateSubmission } from '../src/lib/forms';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

function metric(over: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: newId(),
    metric_key: 'individuals_served',
    label: 'How many individuals did this grant directly serve?',
    help_text: null,
    metric_type: 'integer',
    unit: null,
    is_required: 0,
    sort_order: 10,
    promotes_to: null,
    ...over,
  };
}

let seq = 0;
async function program(metrics: Partial<MetricDefinition>[] = []) {
  const ctx = ctxFor(adminSession());
  const p = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `rf-${++seq}` });
  const now = nowIso();
  const written: MetricDefinition[] = [];
  for (const m of metrics) {
    const row = metric(m);
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, help_text, metric_type, unit,
          is_required, sort_order, status, promotes_to, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      row.id, p.programId, row.metric_key, row.label, row.help_text, row.metric_type,
      row.unit, row.is_required, row.sort_order, (m as { status?: string }).status ?? 'active',
      row.promotes_to, now, now,
    ).run();
    written.push(row);
  }
  return { programId: p.programId, ctx, metrics: written };
}

// ---------------------------------------------------------------------------
describe('turning one metric into one question', () => {
  it('gives each metric type a field that can hold it', () => {
    expect(metricToField(metric({ metric_type: 'integer' })).type).toBe('integer');
    expect(metricToField(metric({ metric_type: 'currency' })).type).toBe('currency');
    expect(metricToField(metric({ metric_type: 'decimal' })).type).toBe('decimal');
    expect(metricToField(metric({ metric_type: 'text' })).type).toBe('long_text');
  });

  it('namespaces the key so a metric cannot collide with a narrative question', () => {
    // A metric CSV is written by somebody who has never seen the narrative
    // questions. "narrative" as a metric_key is not a mistake on their part.
    const f = metricToField(metric({ metric_key: 'narrative' }));
    expect(f.key).toBe(`${METRIC_FIELD_PREFIX}narrative`);
    const keys = DEFAULT_REPORT_NARRATIVE.flatMap((s) => s.fields.map((x) => x.key));
    expect(keys).not.toContain(f.key);
  });

  it('floors counts and rates at zero, and carries the unit through for display', () => {
    const f = metricToField(metric({ metric_type: 'decimal', unit: 'hours' }));
    expect(f.validation).toMatchObject({ min: 0, unit_label: 'hours' });
  });

  it('does not floor currency here, because the money parser already refuses a negative', () => {
    const f = metricToField(metric({ metric_type: 'currency' }));
    expect(f.validation?.min).toBeUndefined();
    expect(f.validation?.min_cents).toBeUndefined();
  });

  it('bounds a text metric so a pasted PDF cannot blow the row limit', () => {
    const f = metricToField(metric({ metric_type: 'text' }));
    expect(f.validation).toMatchObject({ max_length: SCAFFOLDED_TEXT_MAX_LENGTH });
    // A hard ceiling, not an editorial word limit -- no counter is implied.
    expect(f.validation?.max_words).toBeUndefined();
  });

  it('carries required-ness and help text from the definition', () => {
    const f = metricToField(metric({ is_required: 1, help_text: 'Unique individuals.' }));
    expect(f.required).toBe(true);
    expect(f.help).toBe('Unique individuals.');
  });

  it('omits help rather than writing an empty string', () => {
    expect(metricToField(metric({ help_text: null })).help).toBeUndefined();
    expect(metricToField(metric({ help_text: '' })).help).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('the shape of the scaffolded form', () => {
  it('asks what happened before it asks for the numbers', () => {
    const sections = planReportForm([metric()]);
    const keys = sections.map((s) => s.key);
    expect(keys).toEqual(['progress', 'metrics', 'attachments']);
  });

  it('omits the numbers section entirely when a program counts nothing', () => {
    // A program with no metrics gets a narrative report, not an empty heading
    // with nothing under it.
    const sections = planReportForm([]);
    expect(sections.map((s) => s.key)).toEqual(['progress', 'attachments']);
  });

  it('still places the numbers when the caller supplies a narrative with no attachments', () => {
    const sections = planReportForm([metric()], [
      { key: 'progress', title: 'What happened', fields: [] },
    ]);
    expect(sections.map((s) => s.key)).toEqual(['progress', 'metrics']);
  });
});

// ---------------------------------------------------------------------------
describe('writing the draft', () => {
  it('writes a draft report form with no stage, and audits the act once', async () => {
    const p = await program([{ metric_key: 'individuals_served', is_required: 1 }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });

    const row = await db.prepare(
      `SELECT kind, status, stage_id, version, form_key FROM form_definitions WHERE id=?`,
    ).bind(out.formDefinitionId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      kind: 'report', status: 'draft', stage_id: null, version: 1, form_key: 'grant_report',
    });

    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE action='form_definition.scaffolded' AND entity_id=?`,
    ).bind(out.formDefinitionId).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('never publishes, because publishing freezes wording an admin has not read yet', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const row = await db.prepare(`SELECT status, published_at FROM form_definitions WHERE id=?`)
      .bind(out.formDefinitionId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'draft', published_at: null });
  });

  it('links each generated field to the metric it reports', async () => {
    const p = await program([
      { metric_key: 'individuals_served', metric_type: 'integer', sort_order: 10 },
      { metric_key: 'funds_spent', metric_type: 'currency', sort_order: 20 },
    ]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });

    const { results } = await db.prepare(
      `SELECT field_key, field_type, metric_definition_id FROM form_fields
        WHERE form_definition_id=? AND metric_definition_id IS NOT NULL
        ORDER BY sort_order`,
    ).bind(out.formDefinitionId).all<Record<string, unknown>>();

    expect(results.map((r) => r.field_key)).toEqual([
      'metric_individuals_served', 'metric_funds_spent',
    ]);
    expect(results.map((r) => r.field_type)).toEqual(['integer', 'currency']);
    expect(out.metricIds).toEqual(results.map((r) => r.metric_definition_id));
  });

  it('leaves the narrative and attachment questions unlinked', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const row = await db.prepare(
      `SELECT metric_definition_id FROM form_fields
        WHERE form_definition_id=? AND field_key='narrative'`,
    ).bind(out.formDefinitionId).first<{ metric_definition_id: string | null }>();
    expect(row!.metric_definition_id).toBeNull();
  });

  it('asks the metrics in the order the program set, not the order they were entered', async () => {
    const p = await program([
      { metric_key: 'last_question', sort_order: 90 },
      { metric_key: 'first_question', sort_order: 10 },
    ]);
    const metrics = await loadMetricDefinitions(db, p.programId);
    expect(metrics.map((m) => m.metric_key)).toEqual(['first_question', 'last_question']);
  });

  it('leaves a retired metric out of the form but keeps it in the table', async () => {
    // Retiring a metric must not restate last year's totals, so the row stays.
    // It simply stops being asked.
    const p = await program([
      { metric_key: 'still_asked', sort_order: 10 },
      { metric_key: 'no_longer_asked', sort_order: 20, status: 'retired' } as Partial<MetricDefinition>,
    ]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const { results } = await db.prepare(
      `SELECT field_key FROM form_fields
        WHERE form_definition_id=? AND metric_definition_id IS NOT NULL`,
    ).bind(out.formDefinitionId).all<{ field_key: string }>();
    expect(results.map((r) => r.field_key)).toEqual(['metric_still_asked']);

    const kept = await db.prepare(
      `SELECT COUNT(*) AS n FROM metric_definitions WHERE program_id=?`,
    ).bind(p.programId).first<{ n: number }>();
    expect(kept!.n).toBe(2);
  });

  it('breaks a sort_order tie the same way every time', async () => {
    // The index on (program_id, status, sort_order) already returns rows in
    // sort_order, so the ORDER BY's first term is not what this proves -- a tie
    // is. Without the metric_key tiebreak two metrics sharing a sort_order come
    // back in insertion order, and the form's question order then depends on
    // which row a CSV happened to list first.
    const p = await program([
      { metric_key: 'zebra', sort_order: 10 },
      { metric_key: 'aardvark', sort_order: 10 },
    ]);
    const metrics = await loadMetricDefinitions(db, p.programId);
    expect(metrics.map((m) => m.metric_key)).toEqual(['aardvark', 'zebra']);
  });

  it('refuses a narrative that collides with itself, naming the key', async () => {
    // The database would refuse this too, as a constraint violation nobody can
    // read. An admin editing the narrative questions gets a sentence instead.
    const p = await program([]);
    await expect(
      buildReportForm(db, p.ctx, {
        programId: p.programId,
        narrative: [
          { key: 'a', title: 'First', fields: [{ key: 'same', label: 'One', type: 'short_text' }] },
          { key: 'b', title: 'Second', fields: [{ key: 'same', label: 'Two', type: 'short_text' }] },
        ],
      }),
    ).rejects.toMatchObject({
      // publicMessage, not message: an admin reads the sentence, not the log line.
      code: 'VALIDATION_FAILED',
      publicMessage: 'Two questions share the key "same".',
    });
  });

  it('refuses a narrative question that collides with a generated metric field', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    await expect(
      buildReportForm(db, p.ctx, {
        programId: p.programId,
        narrative: [
          {
            key: 'progress',
            title: 'What happened',
            fields: [{ key: 'metric_individuals_served', label: 'Clash', type: 'short_text' }],
          },
          { key: 'attachments', title: 'Files', fields: [] },
        ],
      }),
    ).rejects.toMatchObject({
      publicMessage: 'Two questions share the key "metric_individuals_served".',
    });
  });

  it('mints a new version rather than editing the last one', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const first = await buildReportForm(db, p.ctx, { programId: p.programId });
    const second = await buildReportForm(db, p.ctx, { programId: p.programId });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.formDefinitionId).not.toBe(first.formDefinitionId);
  });

  it('refuses a program that does not exist', async () => {
    await expect(buildReportForm(db, ctxFor(adminSession()), { programId: 'nope' }))
      .rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('the scaffolded form round-trips through the form engine', () => {
  it('loads and validates like any other form', async () => {
    const p = await program([
      { metric_key: 'individuals_served', metric_type: 'integer', is_required: 1 },
      { metric_key: 'volunteer_hours', metric_type: 'decimal', unit: 'hours', sort_order: 20 },
    ]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const def = await loadFormDefinition(db, out.formDefinitionId);

    expect(def.kind).toBe('report');
    expect(def.stage_id).toBeNull();
    expect(allFields(def)).toHaveLength(out.fieldCount);

    const result = validateSubmission(def, {
      narrative: 'We ran a summer reading programme in three libraries.',
      metric_individuals_served: '412',
      metric_volunteer_hours: '37.5',
    });
    expect(result.errors).toEqual([]);

    const byId = new Map(allFields(def).map((f) => [f.field_key, f]));
    const hours = result.answers.get(byId.get('metric_volunteer_hours')!.id)!;
    expect(hours.value_real).toBe(37.5);
    const served = result.answers.get(byId.get('metric_individuals_served')!.id)!;
    expect(served.value_int).toBe(412);
  });

  it('enforces a required metric at submit, in words a grantee can act on', async () => {
    const p = await program([{ metric_key: 'individuals_served', is_required: 1 }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const def = await loadFormDefinition(db, out.formDefinitionId);

    const result = validateSubmission(def, { narrative: 'Something happened.' });
    expect(result.errors.map((e) => e.field)).toContain('metric_individuals_served');
  });

  it('carries metric_definition_id onto the loaded field', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const def = await loadFormDefinition(db, out.formDefinitionId);
    const field = allFields(def).find((f) => f.field_key === 'metric_individuals_served')!;
    expect(field.metric_definition_id).toBe(p.metrics[0]!.id);
  });

  it('writes a decimal answer into report_answers.value_real, which has a typeof check', async () => {
    // The CHECK is typeof(value_real)='real'. A whole number bound into a REAL
    // column has to survive it, or "12 volunteer hours" fails at submit.
    const p = await program([{ metric_key: 'volunteer_hours', metric_type: 'decimal' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const def = await loadFormDefinition(db, out.formDefinitionId);
    const field = allFields(def).find((f) => f.field_key === 'metric_volunteer_hours')!;

    const now = nowIso();
    const awardId = await legacyAward(p.programId);
    const periodId = newId();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,'Final report','final',?,?,?)`,
    ).bind(periodId, awardId, now, now, now).run();

    // One answer per submission: report_answers is unique on (submission,
    // field) and nothing in this schema is ever deleted, so a loop that reused
    // one submission would be testing the unique index instead.
    for (const value of [12, 37.5]) {
      const submissionId = newId();
      await db.prepare(
        `INSERT INTO report_submissions (id, report_period_id, submitted_at, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).bind(submissionId, periodId, now, now, now).run();
      const answerId = newId();
      await db.prepare(
        `INSERT INTO report_answers (id, report_submission_id, form_field_id, value_real, answered_at)
         VALUES (?,?,?,?,?)`,
      ).bind(answerId, submissionId, field.id, value, now).run();
      const back = await db.prepare(
        `SELECT value_real, typeof(value_real) AS t FROM report_answers WHERE id=?`,
      ).bind(answerId).first<{ value_real: number; t: string }>();
      // 12 must come back as a REAL, not an INTEGER: the column's CHECK is
      // typeof(value_real)='real', and REAL affinity is what converts it.
      expect(back).toMatchObject({ value_real: value, t: 'real' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('what the schema refuses', () => {
  it('refuses a metric field on an application form', async () => {
    // A DRAFT application form, so the only rule that can refuse this is the
    // one being tested. Against the seeded published form, the immutability
    // guard and the type guard both also apply, and which one speaks first is
    // not something SQLite promises.
    const p = await program([{ metric_key: 'individuals_served', metric_type: 'integer' }]);
    const now = nowIso();
    const stage = await db.prepare(
      `SELECT id FROM program_stages WHERE program_id=? LIMIT 1`,
    ).bind(p.programId).first<{ id: string }>();

    const defId = newId();
    await db.prepare(
      `INSERT INTO form_definitions
         (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
       VALUES (?,?,'draft_app',?,'application','Draft application',99,'draft',?,?)`,
    ).bind(defId, p.programId, stage!.id, now, now).run();
    const sectionId = newId();
    await db.prepare(
      `INSERT INTO form_sections (id, form_definition_id, section_key, title, sort_order, created_at)
       VALUES (?,?,'s','A section',0,?)`,
    ).bind(sectionId, defId, now).run();

    await expect(
      db.prepare(
        `INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, metric_definition_id, created_at)
         VALUES (?,?,?,'smuggled','How many?','integer',0,0,?,?)`,
      ).bind(newId(), defId, sectionId, p.metrics[0]!.id, now).run(),
    ).rejects.toThrow(/only a report form may carry a metric field/);
  });

  it('refuses a field whose type cannot hold the metric', async () => {
    // The money case: a text field reporting a currency metric coerces to
    // value_text, and TEXT->INTEGER affinity lands "25000" in a cents column
    // as $250.00 with every CHECK passing.
    const p = await program([{ metric_key: 'funds_spent', metric_type: 'currency' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const sectionId = await db.prepare(
      `SELECT id FROM form_sections WHERE form_definition_id=? LIMIT 1`,
    ).bind(out.formDefinitionId).first<{ id: string }>();

    await expect(
      db.prepare(
        `INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, metric_definition_id, created_at)
         VALUES (?,?,?,'sneaky','How much?','short_text',0,99,?,?)`,
      ).bind(newId(), out.formDefinitionId, sectionId!.id, p.metrics[0]!.id, nowIso()).run(),
    ).rejects.toThrow(/cannot collect that metric/);
  });

  it('refuses a metric belonging to another program', async () => {
    const a = await program([{ metric_key: 'individuals_served' }]);
    const b = await program([]);
    const out = await buildReportForm(db, b.ctx, { programId: b.programId });
    const sectionId = await db.prepare(
      `SELECT id FROM form_sections WHERE form_definition_id=? LIMIT 1`,
    ).bind(out.formDefinitionId).first<{ id: string }>();

    await expect(
      db.prepare(
        `INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, metric_definition_id, created_at)
         VALUES (?,?,?,'borrowed','Whose?','integer',0,99,?,?)`,
      ).bind(newId(), out.formDefinitionId, sectionId!.id, a.metrics[0]!.id, nowIso()).run(),
    ).rejects.toThrow(/different program/);
  });

  it('refuses two fields reporting the same metric', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const out = await buildReportForm(db, p.ctx, { programId: p.programId });
    const sectionId = await db.prepare(
      `SELECT id FROM form_sections WHERE form_definition_id=? LIMIT 1`,
    ).bind(out.formDefinitionId).first<{ id: string }>();

    await expect(
      db.prepare(
        `INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, metric_definition_id, created_at)
         VALUES (?,?,?,'again','How many, again?','integer',0,99,?,?)`,
      ).bind(newId(), out.formDefinitionId, sectionId!.id, p.metrics[0]!.id, nowIso()).run(),
    ).rejects.toThrow();
  });

  it('lets only a currency metric claim funds_spent_cents', async () => {
    const p = await program([]);
    const now = nowIso();
    await expect(
      db.prepare(
        `INSERT INTO metric_definitions
           (id, program_id, metric_key, label, metric_type, is_required, sort_order,
            promotes_to, created_at, updated_at)
         VALUES (?,?,'spent_words','How much?','text',0,10,'funds_spent_cents',?,?)`,
      ).bind(newId(), p.programId, now, now).run(),
    ).rejects.toThrow();

    // The currency one is accepted.
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, is_required, sort_order,
          promotes_to, created_at, updated_at)
       VALUES (?,?,'funds_spent','How much?','currency',0,10,'funds_spent_cents',?,?)`,
    ).bind(newId(), p.programId, now, now).run();
  });

  it('lets only one metric per program claim funds_spent_cents', async () => {
    const p = await program([]);
    const now = nowIso();
    const insert = (key: string) => db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, is_required, sort_order,
          promotes_to, created_at, updated_at)
       VALUES (?,?,?,'How much?','currency',0,10,'funds_spent_cents',?,?)`,
    ).bind(newId(), p.programId, key, now, now).run();

    await insert('funds_spent');
    await expect(insert('also_funds_spent')).rejects.toThrow();
  });

  it('agrees with the trigger about which field type collects which metric', () => {
    // The mapping is duplicated: the trigger is the guarantee, this is the
    // scaffolder's choice. Drift between them fails here rather than at a
    // grantee's submit.
    expect(FIELD_TYPE_BY_METRIC_TYPE).toEqual({
      integer: 'integer', currency: 'currency', decimal: 'decimal', text: 'long_text',
    });
  });
});

/** A legacy award: no application, a source system, so reports can hang off it. */
async function legacyAward(programId: string): Promise<string> {
  const now = nowIso();
  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Org ${++seq}`, String(940000000 + seq), now, now).run();
  const id = newId();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?)`,
  ).bind(id, orgId, programId, 2_500_000, now, `RF-${id.slice(0, 8)}`, now, now).run();
  return id;
}

// ---------------------------------------------------------------------------
describe('publishing it, and the obligations waiting for it', () => {
  /** An award with periods already generated, before any form exists. */
  async function awardWithWaitingPeriods(programId: string, ctx: ReturnType<typeof ctxFor>) {
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, `Waiting Org ${++seq}`, String(850000000 + seq), now, now).run();
    const awardId = newId();
    await db.prepare(
      `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
         status, source_system, source_reference, term_start, term_end, created_at, updated_at)
       VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    ).bind(awardId, orgId, programId, 2_500_000, now, `PW-${awardId.slice(0, 8)}`,
           '2025-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', now, now).run();
    await generateReportPeriods(db, ctx, awardId);
    return { awardId, orgId };
  }

  it('attaches the form to every obligation that was waiting for one', async () => {
    /*
     * The defect this pins. Awards are imported before anybody writes the
     * questions, so every period generated in that window pinned NULL -- and
     * generateReportPeriods refuses to touch an award that already has
     * periods, by design. Without this, the portal said "This report form is
     * not ready yet" forever, for every grant imported before the metrics
     * arrived. Which is all of them.
     */
    const p = await program([{ metric_key: 'individuals_served', is_required: 1 }]);
    const a = await awardWithWaitingPeriods(p.programId, p.ctx);

    const before = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string | null }>();
    expect(before!.form_definition_id).toBeNull();

    const built = await buildReportForm(db, p.ctx, { programId: p.programId });
    const out = await publishReportForm(db, p.ctx, built.formDefinitionId);
    expect(out.periodsAttached).toBe(1);

    const after = await db.prepare(
      `SELECT form_definition_id, status FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string; status: string }>();
    expect(after!.form_definition_id).toBe(built.formDefinitionId);
  });

  it('never re-points a period that already names a form', async () => {
    // The freeze: a form edited this March must not change the question a
    // grantee answered last October. Publishing is not a back door through it.
    const p = await program([{ metric_key: 'individuals_served' }]);
    const first = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, first.formDefinitionId);
    const a = await awardWithWaitingPeriods(p.programId, p.ctx);

    const pinned = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string }>();
    expect(pinned!.form_definition_id).toBe(first.formDefinitionId);

    const second = await buildReportForm(db, p.ctx, { programId: p.programId });
    const out = await publishReportForm(db, p.ctx, second.formDefinitionId);
    expect(out.periodsAttached).toBe(0);

    const still = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string }>();
    expect(still!.form_definition_id).toBe(first.formDefinitionId);
  });

  it('leaves a finished obligation alone', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const a = await awardWithWaitingPeriods(p.programId, p.ctx);
    await db.prepare(
      `UPDATE report_periods SET status='waived', waived_reason='Grant returned.' WHERE award_id=?`,
    ).bind(a.awardId).run();

    const built = await buildReportForm(db, p.ctx, { programId: p.programId });
    const out = await publishReportForm(db, p.ctx, built.formDefinitionId);
    expect(out.periodsAttached).toBe(0);
    const row = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string | null }>();
    expect(row!.form_definition_id).toBeNull();
  });

  it('attaches only the waiting ones when a portfolio is in mixed states', async () => {
    /*
     * The real situation, and the one a single-period test cannot see.
     *
     * When nothing is waiting, the attach UPDATE is skipped entirely, so its
     * own WHERE clause is never exercised -- three separate mutations to it
     * survived a suite that only ever had one period at a time. A portfolio
     * with one of each state runs the UPDATE for real.
     */
    const p = await program([{ metric_key: 'individuals_served' }]);

    // Already pinned to the first published form.
    const first = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, first.formDefinitionId);
    const pinned = await awardWithWaitingPeriods(p.programId, p.ctx);

    // Finished, and never to be touched again.
    const waived = await awardWithWaitingPeriods(p.programId, p.ctx);
    await db.prepare(
      `UPDATE report_periods SET form_definition_id=NULL, status='waived',
              waived_reason='Grant returned.' WHERE award_id=?`,
    ).bind(waived.awardId).run();

    // Genuinely waiting.
    const waiting = await awardWithWaitingPeriods(p.programId, p.ctx);
    await db.prepare(`UPDATE report_periods SET form_definition_id=NULL WHERE award_id=?`)
      .bind(waiting.awardId).run();

    const second = await buildReportForm(db, p.ctx, { programId: p.programId });
    const out = await publishReportForm(db, p.ctx, second.formDefinitionId);
    expect(out.periodsAttached).toBe(1);

    const formOn = async (awardId: string) =>
      (await db.prepare(`SELECT form_definition_id AS f FROM report_periods WHERE award_id=?`)
        .bind(awardId).first<{ f: string | null }>())!.f;

    // The pinned one keeps the wording its grantee was shown.
    expect(await formOn(pinned.awardId)).toBe(first.formDefinitionId);
    // The waived one stays finished and unpinned.
    expect(await formOn(waived.awardId)).toBeNull();
    // Only the waiting one opens.
    expect(await formOn(waiting.awardId)).toBe(second.formDefinitionId);
    const waivedStatus = await db.prepare(
      `SELECT status FROM report_periods WHERE award_id=?`,
    ).bind(waived.awardId).first<{ status: string }>();
    expect(waivedStatus!.status).toBe('waived');
  });

  it('opens obligations in its own program and nowhere else', async () => {
    const mine = await program([{ metric_key: 'individuals_served' }]);
    const theirs = await program([{ metric_key: 'individuals_served' }]);
    const a = await awardWithWaitingPeriods(mine.programId, mine.ctx);
    const b = await awardWithWaitingPeriods(theirs.programId, theirs.ctx);

    const built = await buildReportForm(db, mine.ctx, { programId: mine.programId });
    const out = await publishReportForm(db, mine.ctx, built.formDefinitionId);
    expect(out.periodsAttached).toBe(1);

    const other = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(b.awardId).first<{ form_definition_id: string | null }>();
    // A form belongs to its program. Reaching across would ask one program's
    // grantees another program's questions.
    expect(other!.form_definition_id).toBeNull();
    const ours = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string }>();
    expect(ours!.form_definition_id).toBe(built.formDefinitionId);
  });

  it('retires the version it supersedes, because only one may be published', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const first = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, first.formDefinitionId);

    const second = await buildReportForm(db, p.ctx, { programId: p.programId });
    const out = await publishReportForm(db, p.ctx, second.formDefinitionId);
    expect(out.retiredFormDefinitionId).toBe(first.formDefinitionId);

    const statuses = await db.prepare(
      `SELECT id, status FROM form_definitions WHERE program_id=? AND kind='report'
        ORDER BY version`,
    ).bind(p.programId).all<{ id: string; status: string }>();
    expect(statuses.results.map((r) => r.status)).toEqual(['retired', 'published']);
  });

  it('refuses to publish a form with no questions in it', async () => {
    // A failed earlier run can leave an empty definition behind, and a
    // published one is immutable -- so an empty form published once is an
    // empty form forever.
    const p = await program([]);
    const built = await buildReportForm(db, p.ctx, {
      programId: p.programId,
      narrative: [{ key: 'empty', title: 'Nothing here', fields: [] }],
    });
    await expect(publishReportForm(db, p.ctx, built.formDefinitionId))
      .rejects.toMatchObject({ publicMessage: 'This form has no questions in it yet.' });
  });

  it('refuses to publish the same form twice', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    const built = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, built.formDefinitionId);
    await expect(publishReportForm(db, p.ctx, built.formDefinitionId)).rejects.toMatchObject({
      publicMessage: 'This form is already published.',
    });
  });

  it('refuses to publish an application form through this path', async () => {
    const p = await program([]);
    const appForm = await db.prepare(
      `SELECT id FROM form_definitions WHERE program_id=? AND kind='application' LIMIT 1`,
    ).bind(p.programId).first<{ id: string }>();
    await expect(publishReportForm(db, p.ctx, appForm!.id)).rejects.toMatchObject({
      publicMessage: 'That is not a report form.',
    });
  });

  it('audits the publish and says how many obligations it opened', async () => {
    const p = await program([{ metric_key: 'individuals_served' }]);
    await awardWithWaitingPeriods(p.programId, p.ctx);
    await awardWithWaitingPeriods(p.programId, p.ctx);
    const built = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, built.formDefinitionId);

    const row = await db.prepare(
      `SELECT after_json FROM audit_log
        WHERE action='form_definition.published' AND entity_id=?`,
    ).bind(built.formDefinitionId).first<{ after_json: string }>();
    expect(JSON.parse(row!.after_json).report_periods_attached).toBe(2);
  });

  it('lets a grantee file a report that had been waiting on the form', async () => {
    // End to end: the state every imported award is in, then the publish, then
    // a filing that would have been refused ten seconds earlier.
    const p = await program([{ metric_key: 'individuals_served', is_required: 1 }]);
    const a = await awardWithWaitingPeriods(p.programId, p.ctx);
    const period = await db.prepare(
      `SELECT id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ id: string }>();

    const now = nowIso();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
    ).bind(userId, `pw-${newId().slice(0, 6)}@example.org`, a.orgId, now, now).run();
    const session = {
      userId, email: 'pw@example.org', role: 'grantee' as const, organizationId: a.orgId,
    };

    await expect(
      submitReport(db, ctxFor(session), session, period!.id, {
        narrative: 'We did the work.', metric_individuals_served: '412',
      }),
    ).rejects.toMatchObject({ publicMessage: /not ready yet/ });

    const built = await buildReportForm(db, p.ctx, { programId: p.programId });
    await publishReportForm(db, p.ctx, built.formDefinitionId);

    const out = await submitReport(db, ctxFor(session), session, period!.id, {
      narrative: 'We did the work.', metric_individuals_served: '412',
    });
    expect(out.metricsRecorded).toBe(1);
  });
});
