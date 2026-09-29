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
import { AppError, notFound } from './errors';

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
 * ASKING A PAST GRANTEE FOR AN UPDATE, with a date the Foundation chooses.
 *
 * WHY THIS EXISTS ALONGSIDE planReportPeriods RATHER THAN INSIDE IT. Every
 * other route to a report period derives its due date from the award's TERM.
 * That is right for a grant being made now and wrong for one made in 2023: the
 * term ended years ago, so the generated report is born overdue. Three things
 * follow from that, and the third is the one that would actually hurt.
 *
 *   The compliance screen shows every past grantee as delinquent on day one.
 *   Each of them is warned about outstanding reports when they apply again,
 *   for reports nobody had asked them for.
 *   And an award whose term ended inside the reminder chase window gets its
 *   grantee emailed, weekly, about a report that was late before they were
 *   ever asked -- aimed at precisely the people being re-engaged.
 *
 * So an update request is not a late report. It is a NEW obligation created
 * today, due when the Foundation says, and the award's term has nothing to do
 * with it. That is why these periods are `ad_hoc` and why the due date is a
 * required argument rather than a computation.
 *
 * IMPORTED AWARDS CARRY NO TERM AT ALL, deliberately (see the import template),
 * which makes them invisible to planReportPeriods. This is the only way they
 * are ever asked for anything, and that is the intended shape: the deliberate
 * path is the only path.
 */

/** The period type the schema already had for exactly this. */
export const UPDATE_REQUEST_TYPE = 'ad_hoc';

/** One award, and what a run would do about it. */
export interface UpdateRequestRow {
  awardId: string;
  organizationName: string;
  awardedAmountCents: number;
  /** The award date, which is what a run is selected by. */
  awardedAt: string;
  /** Null when it would be asked; a reason when it would not. */
  skipped: string | null;
}

export interface RequestUpdatesResult {
  label: string;
  dueDate: string;
  /** Null when the program has no published report form. See below. */
  formDefinitionId: string | null;
  willAsk: UpdateRequestRow[];
  skipped: UpdateRequestRow[];
  /** Zero on a dry run, however many rows willAsk holds. */
  created: number;
  dryRun: boolean;
}

/** YYYY-MM-DD, and a real day. Rejects 2026-02-31 as well as "soon". */
export function isPlainDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

export async function requestUpdates(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  opts: {
    programId: string;
    /*
     * The window of AWARD DATES to ask, inclusive, as YYYY-MM-DD.
     *
     * Not a fiscal year, because an award does not carry one: the importer
     * parses fiscal_year and drops it, since fiscal_year lives on programs and
     * cannot tell two cycles of one program apart. awarded_at is a fact on the
     * row. It also means the Foundation is never asked to agree with this code
     * about when their year starts.
     */
    awardedFrom: string;
    awardedTo: string;
    /** What the grantee sees this called. "2025 grant update". */
    label: string;
    /** YYYY-MM-DD. Must be in the future -- see the guard. */
    dueDate: string;
    dryRun?: boolean;
    now?: string;
  },
): Promise<RequestUpdatesResult> {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can do that.', {
      internalMessage: `update request attempted by role ${session.role}`,
      severity: 'warn',
    });
  }

  const now = opts.now ?? nowIso();
  const label = opts.label.trim();
  if (!label) {
    throw new AppError('VALIDATION_FAILED', 'Give this update request a name the grantee will see.', {
      internalMessage: 'requestUpdates called with an empty label',
      severity: 'warn',
    });
  }
  if (!isPlainDate(opts.dueDate)) {
    throw new AppError('VALIDATION_FAILED', 'Enter a due date as YYYY-MM-DD.', {
      internalMessage: `requestUpdates called with due date "${opts.dueDate}"`,
      severity: 'warn',
    });
  }
  /*
   * THE GUARD THIS WHOLE FUNCTION EXISTS FOR. A due date in the past creates
   * exactly the born-overdue obligation described above -- by hand this time,
   * which is worse, because somebody typed it.
   */
  if (opts.dueDate <= now.slice(0, 10)) {
    throw new AppError('VALIDATION_FAILED', 'A due date has to be in the future.', {
      internalMessage: `requestUpdates due date ${opts.dueDate} is not after ${now.slice(0, 10)}`,
      severity: 'warn',
    });
  }
  if (!isPlainDate(opts.awardedFrom) || !isPlainDate(opts.awardedTo)) {
    throw new AppError('VALIDATION_FAILED', 'Enter the award dates to cover as YYYY-MM-DD.', {
      internalMessage: `requestUpdates window "${opts.awardedFrom}".."${opts.awardedTo}"`,
      severity: 'warn',
    });
  }
  if (opts.awardedTo < opts.awardedFrom) {
    throw new AppError('VALIDATION_FAILED', 'That window ends before it starts.', {
      internalMessage: `requestUpdates window ${opts.awardedFrom} > ${opts.awardedTo}`,
      severity: 'warn',
    });
  }

  const program = await db
    .prepare(`SELECT id FROM programs WHERE id = ? AND deleted_at IS NULL`)
    .bind(opts.programId)
    .first<{ id: string }>();
  if (!program) throw notFound('program');

  /*
   * The form, pinned now rather than looked up when the grantee opens it.
   * Null is allowed and is not a failure: the obligation is real and dated
   * either way, and refusing to create it until the form exists would mean the
   * Foundation could not decide who to ask before deciding what to ask. The
   * caller is told, and the panel says so.
   */
  const form = await db
    .prepare(
      `SELECT id FROM form_definitions
        WHERE program_id = ? AND kind = 'report' AND status = 'published'
          AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1`,
    )
    .bind(opts.programId)
    .first<{ id: string }>();

  const { results } = await db
    .prepare(
      /*
       * awarded_at is stored as a full timestamp; the window is given as days.
       * Comparing the first ten characters keeps an award made at 4pm on the
       * last day of the window inside it, which a naive <= against the bare
       * date would drop.
       */
      `SELECT a.id AS awardId, a.awarded_amount_cents AS awardedAmountCents,
              a.awarded_at AS awardedAt, a.status AS status,
              o.legal_name AS organizationName,
              (SELECT COUNT(*) FROM report_periods rp
                WHERE rp.award_id = a.id AND rp.deleted_at IS NULL) AS periods
         FROM awards a
         JOIN organizations o ON o.id = a.organization_id AND o.deleted_at IS NULL
        WHERE a.program_id = ? AND a.deleted_at IS NULL
          AND substr(a.awarded_at, 1, 10) >= ?
          AND substr(a.awarded_at, 1, 10) <= ?
        ORDER BY o.legal_name`,
    )
    .bind(opts.programId, opts.awardedFrom, opts.awardedTo)
    .all<{
      awardId: string;
      awardedAmountCents: number;
      awardedAt: string;
      status: string;
      organizationName: string;
      periods: number;
    }>();

  const willAsk: UpdateRequestRow[] = [];
  const skipped: UpdateRequestRow[] = [];
  for (const r of results ?? []) {
    const row: UpdateRequestRow = {
      awardId: r.awardId,
      organizationName: r.organizationName,
      awardedAmountCents: r.awardedAmountCents,
      awardedAt: r.awardedAt,
      skipped: null,
    };
    // A cancelled grant is one nobody took. Asking for a report on it is the
    // defect the reminder path already had to be taught not to repeat.
    if (r.status === 'cancelled') {
      skipped.push({ ...row, skipped: 'this award was cancelled' });
    } else if (r.periods > 0) {
      // Running twice must not ask twice. This is what makes the button safe
      // to press again after a partial run or a change of mind about dates.
      skipped.push({ ...row, skipped: 'this award has already been asked' });
    } else {
      willAsk.push(row);
    }
  }

  if (opts.dryRun) {
    return {
      label, dueDate: opts.dueDate, formDefinitionId: form?.id ?? null,
      willAsk, skipped, created: 0, dryRun: true,
    };
  }

  /*
   * One batch per award, not one for the run. The period and its audit row
   * belong together; a hundred awards in one batch would make the whole ask
   * fail because of one bad row, and D1 has no interactive transaction to roll
   * back to a sensible midpoint.
   */
  for (const row of willAsk) {
    const id = newId();
    await db.batch([
      db
        .prepare(
          `INSERT INTO report_periods (id, award_id, form_definition_id, label, period_type,
             period_start, period_end, opens_at, due_date, status, created_at, updated_at)
           VALUES (?,?,?,?,?,NULL,NULL,?,?,'open',?,?)`,
        )
        .bind(
          id, row.awardId, form?.id ?? null, label, UPDATE_REQUEST_TYPE,
          // Open NOW. A grantee told today that we would like an update should
          // find something they can actually fill in, not a page that says the
          // window has not started.
          now, opts.dueDate, now, now,
        ),
      auditStatement(db, ctx, {
        action: 'report_period.update_requested',
        entityType: 'report_period',
        entityId: id,
        after: {
          award_id: row.awardId,
          label,
          period_type: UPDATE_REQUEST_TYPE,
          due_date: opts.dueDate,
          form_definition_id: form?.id ?? null,
          awarded_at: row.awardedAt,
        },
      }),
    ]);
  }

  return {
    label, dueDate: opts.dueDate, formDefinitionId: form?.id ?? null,
    willAsk, skipped, created: willAsk.length, dryRun: false,
  };
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
