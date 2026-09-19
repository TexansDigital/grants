import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import {
  saveReportDraft, submitReport, loadGranteePeriod, loadOpenDraft, draftAnswers,
  isPeriodFileable, metricColumnFor, metricValueFor,
} from '../src/lib/reportSubmit';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Session } from '../src/types';
import type { FieldDef, StoredValue } from '../src/lib/fieldTypes';
import { EMPTY_VALUE } from '../src/lib/fieldTypes';

const day = (s: string) => `${s}T00:00:00.000Z`;

/** A grantee session, which is an external role scoped to one organization. */
function granteeSession(organizationId: string, userId = newId()): Session {
  return { userId, email: 'grantee@example.org', role: 'grantee', organizationId };
}

let seq = 0;

const METRICS = [
  { key: 'individuals_served', label: 'How many individuals did this grant serve?',
    type: 'integer', unit: 'people', required: 1, order: 10, promotes: null },
  { key: 'funds_spent', label: 'How much of the grant has been spent?',
    type: 'currency', unit: null, required: 1, order: 20, promotes: 'funds_spent_cents' },
  { key: 'volunteer_hours', label: 'Volunteer hours contributed',
    type: 'decimal', unit: 'hours', required: 0, order: 30, promotes: null },
  { key: 'served_basis', label: 'What does that number count?',
    type: 'text', unit: null, required: 0, order: 40, promotes: null },
];

/**
 * A program with metrics, a published report form, an organization holding an
 * award, and the report period that award owes.
 */
async function scenario(
  opts: { termStart?: string; termEnd?: string; metrics?: typeof METRICS } = {},
) {
  const adminCtx = ctxFor(adminSession());
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `rs-${++seq}` });
  const now = nowIso();

  const metricIdByKey = new Map<string, string>();
  for (const m of opts.metrics ?? METRICS) {
    const id = newId();
    metricIdByKey.set(m.key, id);
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
    ).bind(id, p.programId, m.key, m.label, m.type, m.unit, m.required, m.order,
           m.promotes, now, now).run();
  }

  const form = await buildReportForm(db, adminCtx, { programId: p.programId });
  await db.prepare(
    `UPDATE form_definitions SET status='published', published_at=? WHERE id=?`,
  ).bind(now, form.formDefinitionId).run();

  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Grantee ${seq}`, String(930000000 + seq), now, now).run();

  const awardId = newId();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
  ).bind(awardId, orgId, p.programId, 2_500_000, now, `RS-${awardId.slice(0, 8)}`,
         opts.termStart ?? day('2025-01-01'), opts.termEnd ?? day('2025-12-31'),
         now, now).run();

  await generateReportPeriods(db, adminCtx, awardId);
  const period = await db.prepare(
    `SELECT id, form_definition_id, status FROM report_periods WHERE award_id=?`,
  ).bind(awardId).first<{ id: string; form_definition_id: string; status: string }>();

  // A real user row: report_drafts.updated_by_user_id and
  // report_submissions.submitted_by_user_id are foreign keys, and a session
  // whose user does not exist is not a session this system can produce.
  const userId = newId();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, created_at, updated_at)
     VALUES (?,?,'grantee',?,?,?)`,
  ).bind(userId, `grantee${seq}@example.org`, orgId, now, now).run();

  const session = granteeSession(orgId, userId);
  return {
    programId: p.programId, orgId, awardId, session,
    ctx: ctxFor(session), periodId: period!.id, formDefinitionId: form.formDefinitionId,
    metricId: (k: string) => metricIdByKey.get(k)!,
  };
}

const FULL_ANSWERS = {
  narrative: 'We ran a summer reading programme across three branch libraries.',
  challenges: 'One site lost its space in July.',
  metric_individuals_served: '412',
  metric_funds_spent: '$18,750.25',
  metric_volunteer_hours: '137.5',
  metric_served_basis: 'Unique children enrolled, not visits.',
};

// ---------------------------------------------------------------------------
describe('reaching a report period at all', () => {
  it('scopes by the session organization, not by the id in the request', async () => {
    const mine = await scenario();
    const theirs = await scenario();

    // The period exists. It is simply not this grantee's.
    await expect(loadGranteePeriod(db, mine.session, theirs.periodId)).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(loadGranteePeriod(db, mine.session, mine.periodId)).resolves.toMatchObject({
      id: mine.periodId,
    });
  });

  it('refuses a draft saved against a report that is not theirs', async () => {
    const mine = await scenario();
    const theirs = await scenario();
    await expect(
      saveReportDraft(db, mine.ctx, mine.session, theirs.periodId, { narrative: 'hello' }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('refuses a report filed against an award they do not hold', async () => {
    const mine = await scenario();
    const theirs = await scenario();
    await expect(
      submitReport(db, mine.ctx, mine.session, theirs.periodId, FULL_ANSWERS),
    ).rejects.toMatchObject({ httpStatus: 404 });
    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(theirs.periodId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('refuses an internal role outright, rather than scoping it to nothing', async () => {
    const s = await scenario();
    await expect(
      loadGranteePeriod(db, adminSession(), s.periodId),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('refuses an applicant session holding a different organization', async () => {
    // An applicant IS an external role, so scoping rather than role is what
    // stops this. Their own organization id is applied, and it does not match.
    const s = await scenario();
    await expect(
      loadGranteePeriod(db, applicantSession(newId()), s.periodId),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ---------------------------------------------------------------------------
describe('when a report can be filed', () => {
  it('treats a scheduled period whose opening date has passed as open', () => {
    expect(isPeriodFileable({ status: 'scheduled', opens_at: day('2020-01-01') })).toBe(true);
    expect(isPeriodFileable({ status: 'scheduled', opens_at: day('2099-01-01') })).toBe(false);
  });

  it('treats a scheduled period with no opening date as available', () => {
    // A due date entered by hand with no opening date is an obligation.
    // Withholding it would be inventing a rule nobody stated.
    expect(isPeriodFileable({ status: 'scheduled', opens_at: null })).toBe(true);
  });

  it('lets a grantee refile after revisions were requested', () => {
    expect(isPeriodFileable({ status: 'revisions_requested', opens_at: null })).toBe(true);
  });

  it('refuses a period that is submitted, accepted or waived', () => {
    for (const status of ['submitted', 'accepted', 'waived']) {
      expect(isPeriodFileable({ status, opens_at: null }), status).toBe(false);
    }
  });

  it('tells a grantee a report is not open yet rather than failing silently', async () => {
    // A term entirely in the future. Pushing only the END date out would make
    // it a 75-year grant, whose FIRST interim period opened years ago.
    const s = await scenario({ termStart: day('2099-01-01'), termEnd: day('2099-12-31') });
    await expect(
      submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS),
    ).rejects.toMatchObject({ publicMessage: 'This report is not open yet.' });
  });

  it('says so plainly when the program has no report form yet', async () => {
    const s = await scenario();
    await db.prepare(`UPDATE report_periods SET form_definition_id=NULL WHERE id=?`)
      .bind(s.periodId).run();
    const err = await appErrorFrom(submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS));
    expect(err.publicMessage).toBe('This report form is not ready yet. We will be in touch.');
  });
});

// ---------------------------------------------------------------------------
describe('saving a draft', () => {
  it('keeps what was typed, so a closed laptop costs nothing', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'Half a sentence' });
    const draft = await loadOpenDraft(db, s.periodId);
    expect(draftAnswers(draft)).toEqual({ narrative: 'Half a sentence' });
  });

  it('merges sections instead of replacing the whole report', async () => {
    // The form posts the section somebody touched. Replacing the blob would
    // delete every other section they had already filled in.
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'What we did' });
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { metric_individuals_served: '412' });
    const draft = await loadOpenDraft(db, s.periodId);
    expect(draftAnswers(draft)).toEqual({
      narrative: 'What we did', metric_individuals_served: '412',
    });
  });

  it('reuses one draft row rather than accumulating them', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'one' });
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'two' });
    const rows = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_drafts WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it('saves a half-finished report and still reports the type errors in it', async () => {
    const s = await scenario();
    const out = await saveReportDraft(db, s.ctx, s.session, s.periodId, {
      metric_individuals_served: 'four hundred',
    });
    expect(out.errors.map((e) => e.field)).toEqual(['metric_individuals_served']);
    // Saved anyway. Refusing to save an incomplete draft is how work is lost.
    expect(draftAnswers(await loadOpenDraft(db, s.periodId)))
      .toMatchObject({ metric_individuals_served: 'four hundred' });
  });

  it('does not treat a missing required answer as an error while drafting', async () => {
    const s = await scenario();
    const out = await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'Some of it' });
    expect(out.errors).toEqual([]);
  });

  it('keeps field values out of the audit trail', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, {
      narrative: 'A very specific and private sentence',
    });
    const row = await db.prepare(
      `SELECT after_json FROM audit_log WHERE action='report.draft_saved' AND entity_id=?`,
    ).bind(s.periodId).first<{ after_json: string }>();
    expect(row!.after_json).not.toContain('private sentence');
    expect(JSON.parse(row!.after_json)).toMatchObject({ saved_field_keys: ['narrative'] });
  });

  it('refuses a draft too large to be a report', async () => {
    const s = await scenario();
    const err = await appErrorFrom(
      saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'x'.repeat(400_001) }),
    );
    expect(err.publicMessage).toContain('too long to save');
  });
});

// ---------------------------------------------------------------------------
describe('filing it', () => {
  it('writes the submission, the answers and the metrics in one go', async () => {
    const s = await scenario();
    const out = await submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);

    expect(out.metricsRecorded).toBe(4);

    const submission = await db.prepare(
      `SELECT id, report_period_id, funds_spent_cents, submitted_by_user_id
         FROM report_submissions WHERE id=?`,
    ).bind(out.reportSubmissionId).first<Record<string, unknown>>();
    expect(submission).toMatchObject({
      report_period_id: s.periodId,
      // INTEGER CENTS. $18,750.25 is 1,875,025 cents, never 18750.25.
      funds_spent_cents: 1_875_025,
      submitted_by_user_id: s.session.userId,
    });

    const answers = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_answers WHERE report_submission_id=?`,
    ).bind(out.reportSubmissionId).first<{ n: number }>();
    expect(answers!.n).toBe(6);

    const period = await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(s.periodId).first<{ status: string }>();
    expect(period!.status).toBe('submitted');
  });

  it('lands each metric in the column its type aggregates from', async () => {
    const s = await scenario();
    const out = await submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);

    const { results } = await db.prepare(
      `SELECT md.metric_key, mv.value_int, mv.value_real, mv.value_text
         FROM metric_values mv
         JOIN metric_definitions md ON md.id = mv.metric_definition_id
        WHERE mv.report_submission_id=? ORDER BY md.sort_order`,
    ).bind(out.reportSubmissionId).all<Record<string, unknown>>();

    expect(results).toEqual([
      { metric_key: 'individuals_served', value_int: 412, value_real: null, value_text: null },
      { metric_key: 'funds_spent', value_int: 1_875_025, value_real: null, value_text: null },
      { metric_key: 'volunteer_hours', value_int: null, value_real: 137.5, value_text: null },
      { metric_key: 'served_basis', value_int: null, value_real: null,
        value_text: 'Unique children enrolled, not visits.' },
    ]);
  });

  it('takes funds spent from the metric that claims it, not from a guess', async () => {
    const s = await scenario();
    const out = await submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    const mv = await db.prepare(
      `SELECT value_int FROM metric_values
        WHERE report_submission_id=? AND metric_definition_id=?`,
    ).bind(out.reportSubmissionId, s.metricId('funds_spent')).first<{ value_int: number }>();
    // The promoted column and the metric it came from cannot disagree: they are
    // written in the same batch, from the same answer.
    expect(out.fundsSpentCents).toBe(mv!.value_int);
  });

  it('leaves funds spent null when no metric claims it', async () => {
    const s = await scenario({
      metrics: METRICS.slice(0, 2).map((m) => ({ ...m, promotes: null })),
    });
    const out = await submitReport(db, s.ctx, s.session, s.periodId, {
      narrative: 'We did the work.',
      metric_individuals_served: '10',
      metric_funds_spent: '$100',
    });
    expect(out.fundsSpentCents).toBeNull();
  });

  it('records no metric row for a metric left blank', async () => {
    const s = await scenario();
    const out = await submitReport(db, s.ctx, s.session, s.periodId, {
      ...FULL_ANSWERS, metric_volunteer_hours: '', metric_served_basis: '',
    });
    expect(out.metricsRecorded).toBe(2);
    const rows = await db.prepare(
      `SELECT COUNT(*) AS n FROM metric_values WHERE report_submission_id=?`,
    ).bind(out.reportSubmissionId).first<{ n: number }>();
    expect(rows!.n).toBe(2);
  });

  it('files what was drafted when the final screen posts nothing new', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    const out = await submitReport(db, s.ctx, s.session, s.periodId);
    expect(out.metricsRecorded).toBe(4);
    expect(out.fundsSpentCents).toBe(1_875_025);
  });

  it('lets the final screen correct what was drafted', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId,
      { ...FULL_ANSWERS, metric_individuals_served: '1' });
    const out = await submitReport(db, s.ctx, s.session, s.periodId,
      { metric_individuals_served: '412' });
    const mv = await db.prepare(
      `SELECT value_int FROM metric_values
        WHERE report_submission_id=? AND metric_definition_id=?`,
    ).bind(out.reportSubmissionId, s.metricId('individuals_served')).first<{ value_int: number }>();
    expect(mv!.value_int).toBe(412);
  });

  it('closes the draft and links it to what it became', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    const out = await submitReport(db, s.ctx, s.session, s.periodId);

    expect(await loadOpenDraft(db, s.periodId)).toBeNull();
    const draft = await db.prepare(
      `SELECT submitted_at, report_submission_id FROM report_drafts WHERE report_period_id=?`,
    ).bind(s.periodId).first<Record<string, unknown>>();
    expect(draft).toMatchObject({ report_submission_id: out.reportSubmissionId });
    expect(draft!.submitted_at).not.toBeNull();
  });

  it('refuses to rewrite a draft that has been filed', async () => {
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    await submitReport(db, s.ctx, s.session, s.periodId);
    const draft = await db.prepare(
      `SELECT id FROM report_drafts WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ id: string }>();
    await expect(
      db.prepare(`UPDATE report_drafts SET answers_json='{"narrative":"rewritten"}' WHERE id=?`)
        .bind(draft!.id).run(),
    ).rejects.toThrow(/already been filed/);
  });

  it('refuses the whole report when a required metric is missing, writing nothing', async () => {
    const s = await scenario();
    await expect(
      submitReport(db, s.ctx, s.session, s.periodId, { narrative: 'We did the work.' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const submissions = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(submissions!.n).toBe(0);

    const metrics = await db.prepare(
      `SELECT COUNT(*) AS n FROM metric_values mv
         JOIN report_submissions rs ON rs.id = mv.report_submission_id
        WHERE rs.report_period_id = ?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(metrics!.n).toBe(0);
    const period = await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(s.periodId).first<{ status: string }>();
    expect(period!.status).not.toBe('submitted');
  });

  it('files once when the same report is submitted twice', async () => {
    const s = await scenario();
    await submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    await expect(
      submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS),
    ).rejects.toMatchObject({ publicMessage: 'This report has already been filed.' });

    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('audits the filing without copying the report into the audit row', async () => {
    const s = await scenario();
    const out = await submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    const row = await db.prepare(
      `SELECT after_json, actor_user_id FROM audit_log
        WHERE action='report.submitted' AND entity_id=?`,
    ).bind(out.reportSubmissionId).first<{ after_json: string; actor_user_id: string }>();
    expect(row).not.toBeNull();
    expect(row!.actor_user_id).toBe(s.session.userId);
    expect(row!.after_json).not.toContain('summer reading');
    expect(JSON.parse(row!.after_json)).toMatchObject({
      report_period_id: s.periodId,
      funds_spent_cents: 1_875_025,
      metrics_recorded: 4,
    });
  });

  it('refuses an attachment belonging to another organization', async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const now = nowIso();
    const attachmentId = newId();
    await db.prepare(
      `INSERT INTO attachments (id, parent_type, organization_id, r2_key, filename,
         mime_type, size_bytes, uploaded_at)
       VALUES (?, 'report_submission', ?, ?, 'theirs.pdf', 'application/pdf', 10, ?)`,
    ).bind(attachmentId, theirs.orgId, `org/${theirs.orgId}/${attachmentId}`, now).run();

    await expect(
      submitReport(db, mine.ctx, mine.session, mine.periodId, {
        ...FULL_ANSWERS,
        supporting_files: [{ attachment_id: attachmentId, filename: 'theirs.pdf' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(mine.periodId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('claims an attachment the grantee does own', async () => {
    const s = await scenario();
    const now = nowIso();
    const attachmentId = newId();
    await db.prepare(
      `INSERT INTO attachments (id, parent_type, organization_id, r2_key, filename,
         mime_type, size_bytes, uploaded_at)
       VALUES (?, 'report_submission', ?, ?, 'photos.pdf', 'application/pdf', 10, ?)`,
    ).bind(attachmentId, s.orgId, `org/${s.orgId}/${attachmentId}`, now).run();

    const out = await submitReport(db, s.ctx, s.session, s.periodId, {
      ...FULL_ANSWERS,
      supporting_files: [{ attachment_id: attachmentId, filename: 'photos.pdf' }],
    });
    const row = await db.prepare(`SELECT parent_type, parent_id FROM attachments WHERE id=?`)
      .bind(attachmentId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      parent_type: 'report_submission', parent_id: out.reportSubmissionId,
    });
  });
});

// ---------------------------------------------------------------------------
describe('one metric value, read out of one stored answer', () => {
  const field = (field_type: string): FieldDef => ({
    id: 'f1', field_key: 'metric_x', label: 'How much?', help_text: null,
    field_type: field_type as FieldDef['field_type'], is_required: false, sort_order: 0,
    options: [], validation: {}, conditional_on_field_id: null, conditional_value: null,
    maps_to: null, metric_definition_id: 'm1', section_id: 's1',
  });
  const stored = (over: Partial<StoredValue>): StoredValue => ({ ...EMPTY_VALUE, ...over });

  it('reads a count out of value_int', () => {
    expect(metricValueFor(field('integer'), stored({ value_int: 412 })))
      .toEqual({ column: 'value_int', value: 412 });
  });

  it('reads a rate out of value_real, including a whole one', () => {
    expect(metricValueFor(field('decimal'), stored({ value_real: 137.5 })))
      .toEqual({ column: 'value_real', value: 137.5 });
    expect(metricValueFor(field('decimal'), stored({ value_real: 12 })))
      .toEqual({ column: 'value_real', value: 12 });
  });

  it('records nothing for an answer that was left blank', () => {
    expect(metricValueFor(field('integer'), stored({}))).toBeNull();
    expect(metricValueFor(field('integer'), undefined)).toBeNull();
  });

  it('refuses a money value that is not whole cents', () => {
    // coerceAnswer cannot produce this: parseCurrencyToCents returns integers.
    // The assertion is the last line of defence at the BINDING SITE, for a
    // value that reached here some other way -- an imported answer, a future
    // caller, a hand-run script. Without it SQLite's affinity rules decide what
    // a fractional cent means, and it decides quietly.
    expect(() => metricValueFor(field('currency'), stored({ value_int: 1875.5 }))).toThrow();
    expect(() => metricValueFor(field('currency'), stored({ value_int: -1 }))).toThrow();
    expect(() => metricValueFor(field('currency'), stored({ value_int: 10_000_000_001 })))
      .toThrow();
  });

  it('lets a whole-cent money value through', () => {
    expect(metricValueFor(field('currency'), stored({ value_int: 1_875_025 })))
      .toEqual({ column: 'value_int', value: 1_875_025 });
  });

  it('raises rather than dropping a number it cannot place', () => {
    // A field type that cannot promote should never carry a metric -- the 0013
    // trigger refuses it. If one exists anyway, silence would lose the number.
    expect(() => metricValueFor(field('multi_select'), stored({ value_json: '["a"]' })))
      .toThrow();
  });
});

describe('two devices at once', () => {
  it('files once when two submits race, and writes no orphan answers', async () => {
    // Not the sequential case -- that is caught by the status check before any
    // write. This is the race the batch guards exist for: both calls read an
    // open period, both build a batch, and the loser's guards are all false by
    // the time it executes.
    const s = await scenario();
    const results = await Promise.allSettled([
      submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS),
      submitReport(db, s.ctx, s.session, s.periodId, FULL_ANSWERS),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // The loser is told what happened, in a sentence. Without the guard on
    // every statement in the batch, the loser's answer writes run against a
    // submission row that was never inserted, and what comes back is a raw
    // foreign-key error instead.
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as { publicMessage?: string }).publicMessage)
      .toBe('This report has already been filed.');

    const submissions = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(submissions!.n).toBe(1);

    // The loser must not have left its answers behind attached to a submission
    // row that was never written.
    const answers = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_answers ra
        WHERE NOT EXISTS (SELECT 1 FROM report_submissions rs WHERE rs.id = ra.report_submission_id)`,
    ).first<{ n: number }>();
    expect(answers!.n).toBe(0);

    const metrics = await db.prepare(
      `SELECT COUNT(*) AS n FROM metric_values mv
         JOIN report_submissions rs ON rs.id = mv.report_submission_id
        WHERE rs.report_period_id = ?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(metrics!.n).toBe(4);
  });

  it('never says "saved" for an autosave a concurrent filing beat', async () => {
    /*
     * "Saved at 19:41" that did not save is the worst failure this file can
     * produce: the grantee closes the laptop believing their work is safe.
     *
     * Which of the two wins is genuinely a race, so this runs it several times
     * and asserts the same invariant each way round -- resolved means the text
     * is in the draft, rejected means the grantee was told why. Neither branch
     * tolerates a cheerful timestamp over a write that did not happen.
     */
    for (let attempt = 0; attempt < 8; attempt++) {
      const s = await scenario();
      await saveReportDraft(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
      // The save is started a few round-trips behind the submit, so the
      // interesting side of the race -- the autosave that loses -- is the one
      // that actually happens. Without the stagger the save's shorter read path
      // wins every time and the losing branch is never exercised at all.
      const staggered = (async () => {
        for (let i = 0; i < attempt * 2; i++) {
          await db.prepare(`SELECT 1 AS one`).first();
        }
        return saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'one more thought' });
      })();
      const results = await Promise.allSettled([
        submitReport(db, s.ctx, s.session, s.periodId),
        staggered,
      ]);
      const saved = results[1]!;

      expect(results[0]!.status, `attempt ${attempt}: the filing itself`).toBe('fulfilled');

      const { results: drafts } = await db.prepare(
        `SELECT answers_json, submitted_at FROM report_drafts WHERE report_period_id=?`,
      ).bind(s.periodId).all<{ answers_json: string; submitted_at: string | null }>();
      const text = drafts.map((d) => d.answers_json).join(' ');

      // Whoever won, the report has been filed and there is no unfinished work
      // left against it. An open draft here is what the grantee's portal shows
      // them as still to do, on a report they have already sent.
      expect(drafts.filter((d) => d.submitted_at === null), `attempt ${attempt}: stray draft`)
        .toHaveLength(0);

      const saves = await db.prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action='report.draft_saved' AND entity_id=?`,
      ).bind(s.periodId).first<{ n: number }>();

      if (saved.status === 'fulfilled') {
        expect(text, `attempt ${attempt}`).toContain('one more thought');
        expect(saves!.n, `attempt ${attempt}: audited saves`).toBe(2);
      } else {
        expect((saved.reason as { publicMessage?: string }).publicMessage, `attempt ${attempt}`)
          .toBe('This report has already been filed.');
        expect(text, `attempt ${attempt}`).not.toContain('one more thought');
        // ...and no audit row claiming a save that did not happen.
        expect(saves!.n, `attempt ${attempt}: audited saves`).toBe(1);
      }
    }
  });
});

describe('what the draft schema refuses', () => {
  it('refuses a draft claiming an organization that does not hold the award', async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const now = nowIso();
    await expect(
      db.prepare(
        `INSERT INTO report_drafts
           (id, report_period_id, organization_id, form_definition_id, answers_json,
            updated_at, created_at)
         VALUES (?,?,?,?,'{}',?,?)`,
      ).bind(newId(), mine.periodId, theirs.orgId, mine.formDefinitionId, now, now).run(),
    ).rejects.toThrow(/organization that holds the award/);
  });

  it('refuses a second open draft for one period', async () => {
    // Two would mean a phone and a laptop each building a different report,
    // and whichever was filed second would quietly be the one that counted.
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'from the laptop' });
    const now = nowIso();
    await expect(
      db.prepare(
        `INSERT INTO report_drafts
           (id, report_period_id, organization_id, form_definition_id, answers_json,
            updated_at, created_at)
         VALUES (?,?,?,?,'{}',?,?)`,
      ).bind(newId(), s.periodId, s.orgId, s.formDefinitionId, now, now).run(),
    ).rejects.toThrow();
  });

  it('allows a new draft once the previous one has been filed', async () => {
    // A revision request reopens the period, and the grantee starts again. The
    // working state that produced the first filing stays where it is.
    const s = await scenario();
    await saveReportDraft(db, s.ctx, s.session, s.periodId, FULL_ANSWERS);
    await submitReport(db, s.ctx, s.session, s.periodId);
    await db.prepare(
      `UPDATE report_periods SET status='revisions_requested' WHERE id=?`,
    ).bind(s.periodId).run();

    await saveReportDraft(db, s.ctx, s.session, s.periodId, { narrative: 'Second attempt' });
    const drafts = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_drafts WHERE report_period_id=?`,
    ).bind(s.periodId).first<{ n: number }>();
    expect(drafts!.n).toBe(2);
    expect(draftAnswers(await loadOpenDraft(db, s.periodId)))
      .toEqual({ narrative: 'Second attempt' });
  });
});

describe('the promotion mapping', () => {
  it('sends each field type to the column its metric type aggregates from', () => {
    const f = (field_type: string) => ({ field_type } as never);
    expect(metricColumnFor(f('integer'))).toBe('value_int');
    expect(metricColumnFor(f('currency'))).toBe('value_int');
    expect(metricColumnFor(f('decimal'))).toBe('value_real');
    expect(metricColumnFor(f('short_text'))).toBe('value_text');
    expect(metricColumnFor(f('long_text'))).toBe('value_text');
  });

  it('has no column for a field type that cannot carry a metric', () => {
    // The 0013 trigger refuses such a field. If one ever exists anyway,
    // submitReport raises rather than quietly dropping the number.
    expect(metricColumnFor({ field_type: 'multi_select' } as never)).toBeNull();
    expect(metricColumnFor({ field_type: 'file_upload' } as never)).toBeNull();
  });
});
