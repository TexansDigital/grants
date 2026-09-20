/**
 * Working out what a grantee owes, and when.
 *
 * SPLIT IN TWO, like the awards import: `planReportPeriods` is pure and
 * decides; `generateReportPeriods` writes what was decided. The schedule rules
 * are where the arguments live, and a pure function can be argued with in a
 * test rather than by reading SQL.
 *
 * THE SCHEDULE HERE IS A DEFAULT, NOT A POLICY. Real grant administration
 * moves due dates, adds an unplanned interim, and waives reports for a grant
 * returned unspent. Periods are therefore ordinary rows an admin edits, and
 * this only supplies the first draft. Anything that made generated periods
 * immutable would be wrong about how this work actually goes.
 *
 * WITHOUT TERM DATES IT GENERATES NOTHING, and says so. An award imported
 * without a term is common -- the spreadsheet did not have the column -- and
 * inventing a due date from the award date would produce a deadline a grantee
 * is then held to, derived from a guess. Better to report that those awards
 * need their periods entered by hand.
 */

import type { RequestContext, Session } from '../types';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { AppError } from './errors';

/**
 * Days after a term ends before the final report is due.
 *
 * Ninety is the common convention among funders: long enough for a nonprofit
 * to close its books on the project, short enough that the memory of it is
 * still in the building.
 */
export const FINAL_REPORT_DAYS_AFTER_TERM = 90;

/** Days after an interim window closes before that report is due. */
export const INTERIM_REPORT_DAYS_AFTER_PERIOD = 30;

/**
 * A term longer than this gets annual interim reports.
 *
 * Eighteen months rather than twelve: a thirteen-month grant asked for an
 * interim report one month before its final one, which is administration for
 * its own sake.
 */
export const INTERIM_THRESHOLD_MONTHS = 18;

export interface AwardTerm {
  awardId: string;
  termStart: string | null;
  termEnd: string | null;
  isMultiYear: boolean;
}

export interface PlannedPeriod {
  label: string;
  periodType: 'interim' | 'final';
  periodStart: string;
  periodEnd: string;
  opensAt: string;
  dueDate: string;
}

export type PeriodPlan =
  | { ok: true; periods: PlannedPeriod[] }
  /** Nothing can be generated, and why -- for a report an admin reads. */
  | { ok: false; reason: string };

/** Add whole months, clamping a day that the target month does not have. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 0, 0, 0, 0),
  );
  // 31 January plus one month is 28 or 29 February, not 2 or 3 March. Rolling
  // over would drift a report schedule by a day or two per year and put a due
  // date in the wrong month.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/** Whole months between two instants, rounded down. */
export function monthsBetween(startIso: string, endIso: string): number {
  const a = new Date(startIso);
  const b = new Date(endIso);
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return months;
}

/**
 * The default schedule.
 *
 *   No term dates            nothing, with a reason
 *   Term up to 18 months     one final report, due 90 days after the term ends
 *   Longer                   an annual interim at each 12-month mark, then the
 *                            final. The last interim is dropped when it would
 *                            fall within six months of the final one, because
 *                            two reports in a quarter is paperwork rather than
 *                            oversight.
 */
export function planReportPeriods(award: AwardTerm): PeriodPlan {
  const { termStart, termEnd } = award;
  if (!termStart || !termEnd) {
    return {
      ok: false,
      reason:
        'This award has no term dates, so report due dates cannot be worked out. ' +
        'Add a term, or enter the report periods by hand.',
    };
  }
  if (termEnd <= termStart) {
    return { ok: false, reason: 'This award ends on or before it starts.' };
  }

  const periods: PlannedPeriod[] = [];
  const months = monthsBetween(termStart, termEnd);

  if (months > INTERIM_THRESHOLD_MONTHS) {
    let year = 1;
    for (;;) {
      const windowEnd = addMonths(termStart, 12 * year);
      if (windowEnd >= termEnd) break;
      // Six months of the end: the interim and the final would land in the
      // same quarter.
      if (monthsBetween(windowEnd, termEnd) < 6) break;
      periods.push({
        label: `Year ${year} report`,
        periodType: 'interim',
        periodStart: year === 1 ? termStart : addMonths(termStart, 12 * (year - 1)),
        periodEnd: windowEnd,
        opensAt: windowEnd,
        dueDate: addDays(windowEnd, INTERIM_REPORT_DAYS_AFTER_PERIOD),
      });
      year += 1;
      // A term long enough to need ten interim reports is a data error, not a
      // grant. Stopping beats generating a hundred rows from a typo'd year.
      if (year > 10) break;
    }
  }

  periods.push({
    label: 'Final report',
    periodType: 'final',
    periodStart: periods.length > 0 ? periods[periods.length - 1]!.periodEnd : termStart,
    periodEnd: termEnd,
    opensAt: termEnd,
    dueDate: addDays(termEnd, FINAL_REPORT_DAYS_AFTER_TERM),
  });

  return { ok: true, periods };
}

export interface GenerateResult {
  awardId: string;
  created: number;
  /** Set when nothing was generated, and why. */
  skipped: string | null;
}

/**
 * Write the planned periods for one award.
 *
 * IDEMPOTENT BY REFUSAL, not by merge. An award that already has periods is
 * left alone entirely: once a grantee has been told a date, regenerating could
 * move it, and a schedule that shifts under somebody is worse than one that
 * needs a manual edit. Adding a period later is an admin action, not a
 * side effect of running this again.
 */
export async function generateReportPeriods(
  db: D1Database,
  ctx: RequestContext,
  awardId: string,
): Promise<GenerateResult> {
  const award = await db
    .prepare(
      `SELECT id, program_id, term_start, term_end, is_multi_year, status
         FROM awards WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{
      id: string;
      program_id: string;
      term_start: string | null;
      term_end: string | null;
      is_multi_year: number;
      status: string;
    }>();

  if (!award) return { awardId, created: 0, skipped: 'no such award' };
  if (award.status === 'cancelled') {
    return { awardId, created: 0, skipped: 'award is cancelled' };
  }

  const existing = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { awardId, created: 0, skipped: 'this award already has report periods' };
  }

  const plan = planReportPeriods({
    awardId,
    termStart: award.term_start,
    termEnd: award.term_end,
    isMultiYear: award.is_multi_year === 1,
  });
  if (!plan.ok) return { awardId, created: 0, skipped: plan.reason };

  /*
   * The report form, pinned at generation.
   *
   * Null when the program has no published report form yet -- which is the
   * state today, because the form is built from metric definitions the
   * Foundation has not supplied. A period without a form is a real obligation
   * with a date; it simply cannot be filed until the form exists, and that is
   * a truer representation than refusing to schedule anything.
   */
  const form = await db
    .prepare(
      `SELECT id FROM form_definitions
        WHERE program_id = ? AND kind = 'report' AND status = 'published'
          AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1`,
    )
    .bind(award.program_id)
    .first<{ id: string }>();

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const p of plan.periods) {
    const id = newId();
    statements.push(
      db
        .prepare(
          `INSERT INTO report_periods (id, award_id, form_definition_id, label, period_type,
             period_start, period_end, opens_at, due_date, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?)`,
        )
        .bind(
          id, awardId, form?.id ?? null, p.label, p.periodType,
          p.periodStart, p.periodEnd, p.opensAt, p.dueDate, now, now,
        ),
      auditStatement(db, ctx, {
        action: 'report_period.generated',
        entityType: 'report_period',
        entityId: id,
        after: {
          award_id: awardId,
          label: p.label,
          period_type: p.periodType,
          due_date: p.dueDate,
          form_definition_id: form?.id ?? null,
        },
      }),
    );
  }

  await db.batch(statements);
  return { awardId, created: plan.periods.length, skipped: null };
}

/**
 * An award that will never be asked to report.
 *
 * ONE DEFINITION, used by the thing that finds them and the thing that fixes
 * them. The data health screen counts these and the generator below acts on
 * them; two copies of this predicate would drift, and the first anyone would
 * know is a screen saying seven beside a button that fixes five.
 *
 * A WHERE fragment over `awards a`, deliberately not a whole query -- the
 * health check wraps it in a window function and a join, and this one does not.
 */
export const NEEDS_PERIODS_SQL = `
  a.deleted_at IS NULL
  AND a.status IN ('active','completed')
  AND a.term_start IS NOT NULL AND a.term_end IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM report_periods rp
                   WHERE rp.award_id = a.id AND rp.deleted_at IS NULL)`;

/**
 * How many awards one bulk run will touch.
 *
 * Each award is its own db.batch() -- the generator writes a period and its
 * audit row together, and that atomicity is per award, not per run. So a bulk
 * run is N round trips on a single-threaded database, and at 25 to 100 awards
 * a year this cap is far above any real portfolio. It exists so that an import
 * gone wrong cannot turn one button into a thousand writes.
 */
export const BULK_GENERATE_LIMIT = 200;

export interface BulkGenerateResult {
  /** Awards that gained periods, and how many each. */
  generated: GenerateResult[];
  /** Awards looked at but left alone, with the reason. */
  skipped: GenerateResult[];
  periodsCreated: number;
  /** True when more awards needed periods than one run will take. */
  more: boolean;
}

/**
 * Generate periods for every award that has none.
 *
 * Partial success is the normal outcome and is reported as such rather than
 * rolled back: an award whose term dates cannot produce a sensible schedule
 * should not stop the other ninety-nine from getting theirs, and the caller is
 * told exactly which were skipped and why.
 */
export async function generateMissingReportPeriods(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  opts: { limit?: number } = {},
): Promise<BulkGenerateResult> {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can do that.', {
      internalMessage: `bulk report period generation attempted by role ${session.role}`,
      severity: 'warn',
    });
  }

  const limit = Math.max(1, Math.min(opts.limit ?? BULK_GENERATE_LIMIT, BULK_GENERATE_LIMIT));
  const rows = await db
    .prepare(
      `SELECT a.id AS id FROM awards a
        WHERE ${NEEDS_PERIODS_SQL}
        ORDER BY a.awarded_at
        LIMIT ?`,
    )
    .bind(limit + 1)
    .all<{ id: string }>();

  const ids = (rows.results ?? []).map((r) => r.id);
  const more = ids.length > limit;

  const generated: GenerateResult[] = [];
  const skipped: GenerateResult[] = [];
  for (const id of ids.slice(0, limit)) {
    const result = await generateReportPeriods(db, ctx, id);
    (result.created > 0 ? generated : skipped).push(result);
  }

  return {
    generated,
    skipped,
    periodsCreated: generated.reduce((n, g) => n + g.created, 0),
    more,
  };
}
