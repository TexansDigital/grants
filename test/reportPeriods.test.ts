import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  planReportPeriods, generateReportPeriods, addMonths, addDays, monthsBetween,
  FINAL_REPORT_DAYS_AFTER_TERM, INTERIM_REPORT_DAYS_AFTER_PERIOD,
  generateMissingReportPeriods,
  requestUpdates, isPlainDate, UPDATE_REQUEST_TYPE,
} from '../src/lib/reportPeriods';
import { isOverdue, GRANTEE_OWES } from '../src/lib/reportDue';
import { isPeriodFileable } from '../src/lib/reportSubmit';
import { dataHealth } from '../src/lib/dataHealth';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

const day = (s: string) => `${s}T00:00:00.000Z`;
const term = (start: string, end: string, multiYear = false) => ({
  awardId: 'a1', termStart: day(start), termEnd: day(end), isMultiYear: multiYear,
});
const ok = (p: ReturnType<typeof planReportPeriods>) => {
  if (!p.ok) throw new Error(`expected a plan: ${p.reason}`);
  return p.periods;
};

// ---------------------------------------------------------------------------
describe('date arithmetic, which a due date depends on', () => {
  it('adds months without rolling into the next one', () => {
    // 31 January plus a month is the end of February, not the 2nd or 3rd of
    // March. Rolling over drifts a schedule by a day or two per year and puts
    // a due date in the wrong month.
    expect(addMonths(day('2026-01-31'), 1)).toBe(day('2026-02-28'));
    expect(addMonths(day('2028-01-31'), 1)).toBe(day('2028-02-29'));
    expect(addMonths(day('2026-03-31'), 1)).toBe(day('2026-04-30'));
    expect(addMonths(day('2026-01-15'), 12)).toBe(day('2027-01-15'));
  });

  it('counts whole months only', () => {
    expect(monthsBetween(day('2026-01-01'), day('2027-01-01'))).toBe(12);
    // One day short of a year is eleven whole months, not twelve.
    expect(monthsBetween(day('2026-01-02'), day('2027-01-01'))).toBe(11);
    expect(monthsBetween(day('2026-01-01'), day('2026-01-31'))).toBe(0);
  });

  it('adds days across a month boundary', () => {
    expect(addDays(day('2026-03-31'), 90)).toBe(day('2026-06-29'));
  });
});

// ---------------------------------------------------------------------------
describe('the default schedule', () => {
  it('gives a one-year grant a single final report', () => {
    const periods = ok(planReportPeriods(term('2026-04-01', '2027-03-31')));
    expect(periods).toHaveLength(1);
    expect(periods[0]!.periodType).toBe('final');
    expect(periods[0]!.label).toBe('Final report');
    // Ninety days after the term ends: long enough to close the books, short
    // enough that the project is still in memory.
    expect(periods[0]!.dueDate).toBe(addDays(day('2027-03-31'), FINAL_REPORT_DAYS_AFTER_TERM));
    // It covers the whole term.
    expect(periods[0]!.periodStart).toBe(day('2026-04-01'));
    expect(periods[0]!.periodEnd).toBe(day('2027-03-31'));
  });

  it('gives a two-year grant one interim and one final', () => {
    const periods = ok(planReportPeriods(term('2026-04-01', '2028-03-31'), ));
    expect(periods.map((p) => p.periodType)).toEqual(['interim', 'final']);
    expect(periods[0]!.label).toBe('Year 1 report');
    expect(periods[0]!.periodEnd).toBe(day('2027-04-01'));
    expect(periods[0]!.dueDate).toBe(addDays(day('2027-04-01'), INTERIM_REPORT_DAYS_AFTER_PERIOD));
    expect(periods[1]!.periodType).toBe('final');
  });

  it('gives a three-year grant two interims and a final', () => {
    const periods = ok(planReportPeriods(term('2026-01-01', '2029-01-01')));
    expect(periods.map((p) => p.label)).toEqual([
      'Year 1 report', 'Year 2 report', 'Final report',
    ]);
  });

  it('does not ask for an interim within six months of the final one', () => {
    /*
     * A 29-month term: year one ends at month 12, year two at month 24, and
     * the term at 29 -- so a year-two report and the final would land five
     * months apart, which is paperwork rather than oversight.
     *
     * The rule only ever bites from year TWO onwards. For it to drop a
     * year-one report the term would have to be under 18 months, which is
     * below the interim threshold and has no interim to drop. Worth stating,
     * because my first test for this asserted a 19-month grant got no interim
     * -- and 19 months genuinely should have one, nine months clear of the
     * final.
     */
    const periods = ok(planReportPeriods(term('2026-01-01', '2028-06-01')));
    expect(periods.map((p) => p.label)).toEqual(['Year 1 report', 'Final report']);
  });

  it('keeps a year-one report on a 19-month grant, which is far enough clear', () => {
    const periods = ok(planReportPeriods(term('2026-01-01', '2027-08-01')));
    expect(periods.map((p) => p.periodType)).toEqual(['interim', 'final']);
    // Due dates nine months apart, not two.
    expect(monthsBetween(periods[0]!.dueDate, periods[1]!.dueDate)).toBeGreaterThanOrEqual(6);
  });

  it('pins the threshold exactly: 18 months gets one report, 19 gets two', () => {
    /*
     * The only term length that separates the threshold from the crowding
     * rule, and without it the threshold can be deleted entirely with every
     * other test still green.
     *
     * At 18 months a year-one window would close six months clear of the term
     * end, so the crowding rule would keep it -- only the threshold refuses.
     * Below 18 months the crowding rule refuses anyway; above 19 both agree.
     */
    expect(ok(planReportPeriods(term('2026-01-01', '2027-07-01'))).map((p) => p.periodType))
      .toEqual(['final']);
    expect(ok(planReportPeriods(term('2026-01-01', '2027-08-01'))).map((p) => p.periodType))
      .toEqual(['interim', 'final']);
  });

  it('leaves a 13-month grant with one report, not two', () => {
    // The threshold is 18 months rather than 12 for exactly this case.
    const periods = ok(planReportPeriods(term('2026-01-01', '2027-02-01')));
    expect(periods).toHaveLength(1);
  });

  it('covers the whole term with no gaps between periods', () => {
    // A gap is a stretch of the grant nobody ever reports on.
    const periods = ok(planReportPeriods(term('2026-01-01', '2029-01-01')));
    expect(periods[0]!.periodStart).toBe(day('2026-01-01'));
    for (let i = 1; i < periods.length; i += 1) {
      expect(periods[i]!.periodStart, `period ${i}`).toBe(periods[i - 1]!.periodEnd);
    }
    expect(periods[periods.length - 1]!.periodEnd).toBe(day('2029-01-01'));
  });

  it('never opens a period before the work it covers has happened', () => {
    for (const p of ok(planReportPeriods(term('2026-01-01', '2029-01-01')))) {
      expect(p.opensAt >= p.periodEnd, p.label).toBe(true);
      expect(p.dueDate > p.opensAt, p.label).toBe(true);
    }
  });

  it('refuses to invent a schedule with no term dates', () => {
    // An award imported without a term is common: the spreadsheet had no
    // column. Deriving a due date from the award date would produce a deadline
    // a grantee is held to, out of a guess.
    const plan = planReportPeriods({ awardId: 'a', termStart: null, termEnd: null, isMultiYear: false });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable');
    expect(plan.reason).toMatch(/no term dates.*by hand/s);
  });

  it('refuses a term that ends before it starts', () => {
    expect(planReportPeriods(term('2027-01-01', '2026-01-01')).ok).toBe(false);
    expect(planReportPeriods(term('2026-01-01', '2026-01-01')).ok).toBe(false);
  });

  it('does not generate a hundred periods from a typo', () => {
    // A term ending in 2126 is a data error, not a grant.
    const periods = ok(planReportPeriods(term('2026-01-01', '2126-01-01')));
    expect(periods.length).toBeLessThanOrEqual(11);
  });
});

// ---------------------------------------------------------------------------
describe('writing them', () => {
  let n = 0;
  async function award(over: Record<string, unknown> = {}) {
    const ctx = ctxFor(adminSession());
    const p = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `rp-${++n}` });
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, `Org ${n}`, String(950000000 + n), now, now).run();

    const id = newId();
    const row: Record<string, unknown> = {
      id, organization_id: orgId, program_id: p.programId,
      awarded_amount_cents: 2_500_000, awarded_at: now, status: 'active',
      source_system: 'spreadsheet', source_reference: `R-${id.slice(0, 8)}`,
      term_start: day('2026-04-01'), term_end: day('2027-03-31'),
      created_at: now, updated_at: now, ...over,
    };
    const cols = Object.keys(row);
    await db.prepare(
      `INSERT INTO awards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).bind(...cols.map((c) => row[c] as never)).run();
    return { awardId: id, programId: p.programId, ctx };
  }

  it('writes the planned periods and audits each one', async () => {
    const a = await award();
    const out = await generateReportPeriods(db, a.ctx, a.awardId);
    expect(out).toMatchObject({ created: 1, skipped: null });

    const rows = await db.prepare(
      `SELECT label, period_type, due_date, status FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ label: 'Final report', status: 'scheduled' });

    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='report_period.generated'`,
    ).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('leaves an award alone that already has periods', async () => {
    // Once a grantee has been told a date, regenerating could move it. A
    // schedule that shifts under somebody is worse than one needing an edit.
    const a = await award();
    await generateReportPeriods(db, a.ctx, a.awardId);
    const again = await generateReportPeriods(db, a.ctx, a.awardId);
    expect(again).toMatchObject({ created: 0, skipped: 'this award already has report periods' });

    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('says which awards need periods entered by hand', async () => {
    const a = await award({ term_start: null, term_end: null });
    const out = await generateReportPeriods(db, a.ctx, a.awardId);
    expect(out.created).toBe(0);
    expect(out.skipped).toMatch(/no term dates/);
    // And writes nothing at all.
    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('schedules nothing for a cancelled award', async () => {
    const a = await award({ status: 'cancelled' });
    expect((await generateReportPeriods(db, a.ctx, a.awardId)).skipped).toMatch(/cancelled/);
  });

  it('is a no-op for an award that does not exist', async () => {
    const a = await award();
    expect((await generateReportPeriods(db, a.ctx, newId())).skipped).toBe('no such award');
  });

  it('leaves the form unset when the program has no published report form', async () => {
    /*
     * The state today: the report form is built from metric definitions the
     * Foundation has not supplied. A period with no form is still a real
     * obligation with a real date -- it just cannot be filed yet -- and that
     * is truer than refusing to schedule anything.
     */
    const a = await award();
    await generateReportPeriods(db, a.ctx, a.awardId);
    const row = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string | null }>();
    expect(row!.form_definition_id).toBeNull();
  });

  it('pins the published report form when the program has one', async () => {
    // Pinned at generation, not looked up at filing: a form edited between a
    // period opening and a grantee filing would change the question under an
    // answer already being written.
    const a = await award();
    const now = nowIso();
    const formId = newId();
    // stage_id must be NULL for a report form: migration 0003 CHECKs
    // (kind = 'application') = (stage_id IS NOT NULL), because a report
    // belongs to an award rather than to a stage of an application.
    await db.prepare(
      `INSERT INTO form_definitions (id, program_id, stage_id, form_key, kind, name, version,
         status, published_at, created_at, updated_at)
       VALUES (?,?,NULL,?,'report',?,1,'published',?,?,?)`,
    ).bind(formId, a.programId, 'final-report', 'Final report', now, now, now).run();

    await generateReportPeriods(db, a.ctx, a.awardId);
    const row = await db.prepare(
      `SELECT form_definition_id FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ form_definition_id: string | null }>();
    expect(row!.form_definition_id).toBe(formId);
  });

  it('writes a multi-year schedule in one go', async () => {
    const a = await award({ term_start: day('2026-01-01'), term_end: day('2029-01-01'), is_multi_year: 1 });
    expect((await generateReportPeriods(db, a.ctx, a.awardId)).created).toBe(3);
    const rows = await db.prepare(
      `SELECT label FROM report_periods WHERE award_id=? ORDER BY due_date`,
    ).bind(a.awardId).all<{ label: string }>();
    expect(rows.results.map((r) => r.label)).toEqual([
      'Year 1 report', 'Year 2 report', 'Final report',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('generating for every award that has none', () => {
  let n = 0;
  const admin = adminSession();

  async function award(over: Record<string, unknown> = {}) {
    const ctx = ctxFor(admin);
    const p = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `bulk-${++n}` });
    const now = nowIso();
    const orgId = newId();
    await db
      .prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      )
      .bind(orgId, `Bayou Reach ${n}`, String(960000000 + n), now, now)
      .run();

    const id = newId();
    const row: Record<string, unknown> = {
      id,
      organization_id: orgId,
      program_id: p.programId,
      awarded_amount_cents: 2_500_000,
      awarded_at: day('2026-03-04'),
      status: 'active',
      term_start: day('2026-04-01'),
      term_end: day('2027-03-31'),
      source_system: 'spreadsheet',
      source_reference: `B-${id.slice(0, 8)}`,
      created_at: now,
      updated_at: now,
      ...over,
    };
    const cols = Object.keys(row);
    await db
      .prepare(`INSERT INTO awards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .bind(...cols.map((c) => row[c] as never))
      .run();
    return id;
  }

  const periodsFor = async (awardId: string) =>
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM report_periods WHERE award_id = ?`)
        .bind(awardId)
        .first<{ n: number }>()
    )?.n ?? 0;

  it('refuses anyone who is not an admin', async () => {
    const e = await appErrorFrom(
      generateMissingReportPeriods(db, ctxFor(reviewerSession()), reviewerSession()),
    );
    expect(e.code).toBe('FORBIDDEN');
  });

  it('gives periods to every award that had none', async () => {
    const a = await award();
    const b = await award();

    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.generated.length).toBe(2);
    expect(out.periodsCreated).toBe(2);
    expect(out.skipped).toEqual([]);
    expect(await periodsFor(a)).toBe(1);
    expect(await periodsFor(b)).toBe(1);
  });

  it('leaves an award that already has periods entirely alone', async () => {
    const already = await award();
    await generateReportPeriods(db, ctxFor(admin), already);
    const before = await periodsFor(already);

    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.generated).toEqual([]);
    expect(await periodsFor(already)).toBe(before);
  });

  it('is safe to run twice', async () => {
    await award();
    const first = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    const second = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(first.periodsCreated).toBe(1);
    expect(second.periodsCreated).toBe(0);
    expect(second.generated).toEqual([]);
  });

  it('ignores an award with no term, which cannot be scheduled', async () => {
    await award({ term_start: null, term_end: null });
    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.generated).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it('ignores a cancelled award', async () => {
    await award({ status: 'cancelled' });
    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.periodsCreated).toBe(0);
  });

  it('does not even look at a soft-deleted award', async () => {
    const gone = await award();
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), gone).run();
    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.periodsCreated).toBe(0);
    // And is not picked up only to be refused a query later as "no such
    // award", which would surface to an admin as a problem with their data.
    expect(out.skipped).toEqual([]);
    expect(out.generated).toEqual([]);
  });

  /*
   * Obligations and grants are different numbers, and the difference only
   * shows on a multi-year term: over 18 months the planner adds an interim
   * report, so two grants can owe three reports. Every other fixture here has
   * a 12-month term and exactly one final report, which makes "count the
   * grants" and "count the obligations" indistinguishable.
   */
  it('counts obligations, not grants', async () => {
    await award();
    await award({
      term_start: day('2026-04-01'),
      term_end: day('2028-03-31'),
      is_multi_year: 1,
    });

    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.generated.length).toBe(2);
    expect(out.periodsCreated).toBe(3);
    expect(out.generated.map((g) => g.created).sort()).toEqual([1, 2]);
  });

  /*
   * Partial success is the point. One award whose dates cannot produce a
   * sensible schedule must not stop the rest, and the caller has to be told
   * which were left and why -- an all-or-nothing bulk action on a hundred
   * grants is unusable, because one bad row makes it do nothing forever.
   */
  it('reports what it skipped without abandoning the rest', async () => {
    const good = await award();
    /*
     * A ZERO-LENGTH term. The schema permits it -- its CHECK is
     * `term_end >= term_start` -- and the planner refuses it, because its
     * guard is `termEnd <= termStart`. That one-character difference is the
     * only gap through which an unschedulable award can reach the generator,
     * and it is why `skipped` is a real branch rather than a defensive one.
     */
    const bad = await award({ term_start: day('2026-04-01'), term_end: day('2026-04-01') });

    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.generated.map((g) => g.awardId)).toEqual([good]);
    expect(out.skipped.map((g) => g.awardId)).toEqual([bad]);
    expect(out.skipped[0]!.skipped).toBeTruthy();
    expect(await periodsFor(good)).toBe(1);
  });

  it('stops at the limit and says there is more', async () => {
    await award();
    await award();
    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin, { limit: 1 });
    expect(out.generated.length).toBe(1);
    expect(out.more).toBe(true);
  });

  it('does not claim there is more when it finished', async () => {
    await award();
    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin, { limit: 1 });
    expect(out.more).toBe(false);
  });

  /*
   * The data health screen counts these awards and this generates for them.
   * They must agree, or the screen says seven beside a button that fixes five.
   */
  it('acts on exactly what data health counts', async () => {
    await award();
    await award();
    await award({ term_start: null, term_end: null });
    await award({ status: 'cancelled' });

    const before = await dataHealth(db, admin);
    const counted =
      before.checks.find((c) => c.key === 'award_no_report_periods')?.count ?? -1;
    expect(counted).toBe(2);

    const out = await generateMissingReportPeriods(db, ctxFor(admin), admin);
    expect(out.periodsCreated).toBe(counted);

    const after = await dataHealth(db, admin);
    expect(after.checks.find((c) => c.key === 'award_no_report_periods')?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
/*
 * Asking a past grantee for an update.
 *
 * The thing under test is not "does a row get written". It is that a grant made
 * in 2025 can be asked for an update in 2026 WITHOUT the obligation being born
 * overdue -- which is what every other path in this file would produce, because
 * every other path derives the due date from a term that has already ended.
 */
describe('requesting an update on a past grant', () => {
  let k = 0;
  async function pastGrant(over: Record<string, unknown> = {}) {
    const ctx = ctxFor(adminSession());
    const p = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: `ru-${++k}` });
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,NULL,'active',?,?)`,
    ).bind(orgId, `Past Grantee ${k}`, now, now).run();
    const id = newId();
    const row: Record<string, unknown> = {
      id, organization_id: orgId, program_id: p.programId,
      awarded_amount_cents: 2_500_000, awarded_at: day('2025-03-06'),
      status: 'completed',
      source_system: 'spreadsheet', source_reference: `IC-${id.slice(0, 8)}`,
      // No term. That is the point: an imported past grant has none.
      term_start: null, term_end: null,
      created_at: now, updated_at: now, ...over,
    };
    const cols = Object.keys(row);
    await db.prepare(
      `INSERT INTO awards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).bind(...cols.map((c) => row[c] as never)).run();
    return { awardId: id, programId: p.programId, orgId, ctx };
  }

  const FUTURE = '2027-11-14';
  const ask = (programId: string, ctx: ReturnType<typeof ctxFor>, over = {}) =>
    requestUpdates(db, ctx, adminSession(), {
      programId, awardedFrom: '2025-01-01', awardedTo: '2025-12-31',
      label: '2025 grant update', dueDate: FUTURE, ...over,
    });

  it('asks an award that planReportPeriods cannot touch at all', async () => {
    // The whole reason this exists: no term means no plan.
    const a = await pastGrant();
    expect(planReportPeriods({
      awardId: a.awardId, termStart: null, termEnd: null, isMultiYear: false,
    }).ok).toBe(false);

    const out = await ask(a.programId, a.ctx);
    expect(out).toMatchObject({ created: 1, dryRun: false });
    expect(out.willAsk[0]!.organizationName).toBe(`Past Grantee ${k}`);
  });

  it('is NOT overdue the moment it is created', async () => {
    /*
     * The assertion this module was written for. Derive the date from the term
     * and this is false on day one for every grant in the import.
     */
    const a = await pastGrant();
    await ask(a.programId, a.ctx);
    const row = (await db.prepare(
      `SELECT status, due_date, opens_at, period_type FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ status: string; due_date: string; opens_at: string; period_type: string }>())!;

    expect(isOverdue(row.status, row.due_date, nowIso())).toBe(false);
    expect(row.period_type).toBe(UPDATE_REQUEST_TYPE);
  });

  it('is fileable immediately, not scheduled for later', async () => {
    // Telling somebody today that we would like an update, and showing them a
    // page that says the window has not opened, is the same as not asking.
    const a = await pastGrant();
    await ask(a.programId, a.ctx);
    const row = (await db.prepare(
      `SELECT status, opens_at FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ status: string; opens_at: string }>())!;
    expect(row.status).toBe('open');
    expect(isPeriodFileable(row, nowIso())).toBe(true);
    expect(GRANTEE_OWES).toContain(row.status);
  });

  it('uses the due date given, never one derived from the award', async () => {
    const a = await pastGrant();
    await ask(a.programId, a.ctx);
    const row = (await db.prepare(
      `SELECT due_date, label FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ due_date: string; label: string }>())!;
    expect(row.due_date).toBe(FUTURE);
    expect(row.label).toBe('2025 grant update');
  });

  it('refuses a due date in the past', async () => {
    // By hand is worse than by derivation: somebody typed it.
    const a = await pastGrant();
    const e = await appErrorFrom(ask(a.programId, a.ctx, { dueDate: '2020-01-01' }));
    expect(e.publicMessage).toMatch(/has to be in the future/i);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('refuses a date that is not a date, and 31 February', async () => {
    expect(isPlainDate('2027-11-14')).toBe(true);
    expect(isPlainDate('2026-02-31')).toBe(false);
    expect(isPlainDate('14/11/2027')).toBe(false);
    expect(isPlainDate('soon')).toBe(false);
  });

  it('refuses an empty label and a window that is not dates', async () => {
    const a = await pastGrant();
    expect((await appErrorFrom(ask(a.programId, a.ctx, { label: '  ' }))).publicMessage)
      .toMatch(/name the grantee will see/i);
    expect((await appErrorFrom(ask(a.programId, a.ctx, { awardedFrom: 'soon' }))).publicMessage)
      .toMatch(/award dates to cover/i);
  });

  it('never asks twice, so the button is safe to press again', async () => {
    const a = await pastGrant();
    expect((await ask(a.programId, a.ctx)).created).toBe(1);
    const second = await ask(a.programId, a.ctx);
    expect(second.created).toBe(0);
    expect(second.skipped[0]!.skipped).toMatch(/already been asked/i);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it('skips a cancelled grant, because nobody took it', async () => {
    const a = await pastGrant({ status: 'cancelled' });
    const out = await ask(a.programId, a.ctx);
    expect(out.created).toBe(0);
    expect(out.skipped[0]!.skipped).toMatch(/cancelled/i);
  });

  it('asks only the award dates chosen', async () => {
    const a = await pastGrant();
    const out = await ask(a.programId, a.ctx,
      { awardedFrom: '2023-01-01', awardedTo: '2023-12-31' });
    expect(out.created).toBe(0);
    expect(out.willAsk).toHaveLength(0);
  });

  it('includes an award made on the last day of the window', async () => {
    // awarded_at is a timestamp and the window is days. A bare <= against the
    // date drops anything awarded after midnight on the closing day.
    const a = await pastGrant({ awarded_at: '2025-12-31T16:00:00.000Z' });
    const out = await ask(a.programId, a.ctx);
    expect(out.created).toBe(1);
  });

  it('refuses a window that ends before it starts', async () => {
    const a = await pastGrant();
    const e = await appErrorFrom(ask(a.programId, a.ctx,
      { awardedFrom: '2025-12-31', awardedTo: '2025-01-01' }));
    expect(e.publicMessage).toMatch(/ends before it starts/i);
  });

  it('writes nothing on a dry run, and says what it would do', async () => {
    const a = await pastGrant();
    const out = await ask(a.programId, a.ctx, { dryRun: true });
    expect(out).toMatchObject({ created: 0, dryRun: true });
    expect(out.willAsk).toHaveLength(1);
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id=?`,
    ).bind(a.awardId).first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it('audits each one as REQUESTED, not as generated', async () => {
    // Two different facts. Generated means derived from a term; requested means
    // a person chose to ask, and chose the date they will be held to.
    const a = await pastGrant();
    await ask(a.programId, a.ctx);
    const row = await db.prepare(
      `SELECT action, after_json FROM audit_log
        WHERE entity_type='report_period' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ action: string; after_json: string }>();
    expect(row!.action).toBe('report_period.update_requested');
    expect(JSON.parse(row!.after_json)).toMatchObject({ due_date: FUTURE });
  });

  it('refuses a reviewer', async () => {
    const a = await pastGrant();
    const e = await appErrorFrom(requestUpdates(db, a.ctx, reviewerSession(), {
      programId: a.programId, awardedFrom: '2025-01-01', awardedTo: '2025-12-31',
      label: 'x', dueDate: FUTURE,
    }));
    expect(e.publicMessage).toMatch(/administrator/i);
  });

  it('still asks when no report form is published, and says the form is missing', async () => {
    /*
     * Deliberate. Refusing to create the obligation until a form exists would
     * mean the Foundation cannot decide WHO to ask before deciding WHAT to ask,
     * and the date is the part with a deadline attached.
     */
    const a = await pastGrant();
    const out = await ask(a.programId, a.ctx);
    expect(out.created).toBe(1);
    expect(out.formDefinitionId).toBeNull();
  });
});
