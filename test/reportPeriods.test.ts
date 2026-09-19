import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import {
  planReportPeriods, generateReportPeriods, addMonths, addDays, monthsBetween,
  FINAL_REPORT_DAYS_AFTER_TERM, INTERIM_REPORT_DAYS_AFTER_PERIOD,
} from '../src/lib/reportPeriods';
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
