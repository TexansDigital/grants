/**
 * What the money did, and how much of the picture we actually have.
 *
 * THE SECOND HALF OF THAT SENTENCE IS THE WHOLE POINT. The dashboard already
 * totals the impact metrics, and a total on its own is the most misleading
 * number this platform can produce. "4,200 people served" is a fact if every
 * grantee has filed and a floor if three of thirteen have, and the figure
 * reads identically either way -- while going straight into a board paper, a
 * league report, or a press line, where nobody can see the denominator any
 * more.
 *
 * So every number on this screen is reported with the coverage behind it, and
 * the coverage is computed here rather than left for a reader to assemble
 * from the compliance desk. A total whose denominator is unknown is not an
 * achievement; it is an unsourced claim.
 *
 * WHY IT IS NOT THE DASHBOARD. The dashboard answers "how is the programme
 * running" -- applications received, committed against budget, compliance
 * rate. This answers "what changed in the world", which is a different
 * question with a different audience and, crucially, a different failure
 * mode: the dashboard being out of date is an inconvenience, and this being
 * quoted without its denominator is a misstatement.
 *
 * WHAT IT DOES NOT DO. It does not aggregate text metrics, ever. A written
 * answer summed or counted into a figure is a fabrication. The explicit
 * `metric_type = 'text' THEN NULL` branch below is, today, unreachable: 0012
 * constrains metric_values so that at most one of value_int, value_real and
 * value_text is populated, so a text metric's SUM(value_int) is NULL whatever
 * this query says -- a mutation run confirmed removing the branch changes no
 * result. It stays for the reason dashboard.ts gives for its twin: the
 * redundancy is accidental, and the day somebody writes a plausible "handle
 * both" ELSE, a written answer starts producing a number and "Populations
 * served: 0" reads as "we served nobody". The test asserts the CONSTRAINT, so
 * if that is ever relaxed this stops being belt-and-braces.
 */

import type { Session } from '../types';
import { AppError } from './errors';
import { isStaffRole } from './scope';

export interface ImpactMetric {
  metricDefinitionId: string;
  label: string;
  /** 'integer' | 'currency' | 'decimal' | 'text'. */
  metricType: string;
  unit: string | null;
  /*
   * Null for a text metric, which is never aggregated, AND null for a numeric
   * metric nobody has answered -- those are different states and the screen
   * distinguishes them by `answered`, not by inventing a zero. "0 people
   * served" and "nobody has told us yet" must never render the same.
   */
  total: number | null;
  /** How many accepted reports carried a value for this metric. */
  answered: number;
}

export interface ImpactProgram {
  programId: string;
  programName: string;
  metrics: ImpactMetric[];
  /*
   * COVERAGE. Report periods that exist, and how many have been accepted.
   * `obligations` counts periods rather than grants, because a multi-year
   * grant owes several and a grant nobody has asked owes none -- and a grant
   * nobody has asked is invisible here by construction, which is why the
   * screen also says how many grants carry no obligation at all.
   */
  obligations: number;
  accepted: number;
  /** Grants in this programme with no report obligation of any kind. */
  grantsNeverAsked: number;
  /** Grants counted in the coverage above. */
  grants: number;
  totalAwardedCents: number;
}

export interface Impact {
  generatedAt: string;
  /** The year filtered to, or null for everything. */
  year: number | null;
  /** Years that have a report period, newest first. For the picker. */
  years: number[];
  programs: ImpactProgram[];
}

/**
 * The year a report period belongs to.
 *
 * The period's END, not its due date: a 2025 grant year reported on in
 * January 2026 is 2025 impact, and filing late must not move it into the
 * following year's totals. Falls back to the due date only when the period
 * carries no dates, which is the shape `requestUpdates` writes.
 */
const PERIOD_YEAR = `CAST(substr(COALESCE(rp.period_end, rp.due_date), 1, 4) AS INTEGER)`;

export async function impact(
  db: D1Database,
  session: Session,
  nowIso: string,
  year: number | null = null,
): Promise<Impact> {
  /*
   * Admin only. These totals are the Foundation's to publish and the figures
   * are drawn from every programme at once, which is outside a reviewer's
   * scope in the same way award amounts are.
   */
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `impact reached by role ${session.role}${isStaffRole(session) ? ' (staff)' : ''}`,
      severity: 'error',
    });
  }

  const yearFilter = year === null ? '' : ` AND ${PERIOD_YEAR} = ?`;
  const yearBind: unknown[] = year === null ? [] : [year];

  const [years, metrics, coverage, neverAsked] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT ${PERIOD_YEAR} AS y
           FROM report_periods rp
          WHERE rp.deleted_at IS NULL AND ${PERIOD_YEAR} IS NOT NULL
          ORDER BY y DESC`,
      )
      .all<{ y: number }>(),

    /*
     * Values from ACCEPTED submissions only.
     *
     * A submitted-but-unread report is a claim the Foundation has not looked
     * at. Counting it would mean a number in a board paper that no member of
     * staff has ever read, and it would move -- silently, downward -- if that
     * report were later sent back for revision.
     */
    db
      .prepare(
        /*
         * COUNTED IN THE AGGREGATE, NOT FILTERED IN THE WHERE, and the
         * difference is a bug this had. Filtering the row out when the value
         * does not count made the whole METRIC disappear: a programme where
         * one grantee had filed and the report was then sent back for
         * revision lost "Individuals served" from the screen altogether,
         * rather than reading "nobody has answered yet". Same for a year with
         * no accepted reports -- the year looked like it had no metrics
         * rather than no answers.
         *
         * So the join stays outer, nothing is filtered, and the condition
         * moves inside COUNT and SUM. The definition is always present; only
         * its numbers depend on what has been accepted.
         */
        `SELECT p.id AS programId, p.name AS programName,
                md.id AS metricDefinitionId, md.label,
                md.metric_type AS metricType, md.unit, md.sort_order AS sortOrder,
                COUNT(CASE WHEN rp.id IS NOT NULL THEN mv.id END) AS answered,
                CASE WHEN md.metric_type = 'text' THEN NULL
                     WHEN md.metric_type = 'decimal'
                       THEN SUM(CASE WHEN rp.id IS NOT NULL THEN mv.value_real END)
                     ELSE SUM(CASE WHEN rp.id IS NOT NULL THEN mv.value_int END)
                END AS total
           FROM metric_definitions md
           JOIN programs p ON p.id = md.program_id
           LEFT JOIN metric_values mv ON mv.metric_definition_id = md.id
           LEFT JOIN report_submissions rs
                  ON rs.id = mv.report_submission_id
                 AND rs.accepted_at IS NOT NULL
                 AND rs.deleted_at IS NULL
           /*
            * rp carries the year filter in its ON, so the rp.id IS NOT NULL
            * test above means "accepted, and in the year asked for" -- and when no
            * year is asked for, simply "accepted against a live period". A
            * value whose period was soft-deleted does not count either, which
            * is why the condition tests rp rather than rs.
            */
           LEFT JOIN report_periods rp
                  ON rp.id = rs.report_period_id
                 AND rp.deleted_at IS NULL${yearFilter}
          WHERE md.deleted_at IS NULL AND p.deleted_at IS NULL
          GROUP BY md.id
          ORDER BY p.name, md.sort_order, md.label`,
      )
      .bind(...yearBind)
      .all<Record<string, unknown>>(),

    /*
     * THE DENOMINATOR. Obligations and how many are settled, per programme,
     * alongside the money those grants represent -- so "4,200 people" can be
     * read against "from 3 of 13 updates, covering $120,000 of $469,000".
     */
    db
      .prepare(
        `SELECT p.id AS programId, p.name AS programName,
                COUNT(rp.id) AS obligations,
                SUM(CASE WHEN rp.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
                COUNT(DISTINCT w.id) AS grants,
                -- DISTINCT inside the sum, because a grant with three
                -- obligations would otherwise have its amount counted three
                -- times. Integer cents throughout; no float touches this.
                COALESCE((SELECT SUM(w2.awarded_amount_cents)
                            FROM awards w2
                           WHERE w2.program_id = p.id AND w2.deleted_at IS NULL
                             AND EXISTS (SELECT 1 FROM report_periods rp2
                                          WHERE rp2.award_id = w2.id
                                            AND rp2.deleted_at IS NULL
                                            ${year === null ? '' : `AND CAST(substr(COALESCE(rp2.period_end, rp2.due_date), 1, 4) AS INTEGER) = ?`})
                         ), 0) AS totalAwardedCents
           FROM programs p
           LEFT JOIN awards w ON w.program_id = p.id AND w.deleted_at IS NULL
           LEFT JOIN report_periods rp
                  ON rp.award_id = w.id AND rp.deleted_at IS NULL${yearFilter}
          WHERE p.deleted_at IS NULL
          GROUP BY p.id
          ORDER BY p.name`,
      )
      .bind(...yearBind, ...yearBind)
      .all<Record<string, unknown>>(),

    /*
     * Grants with NO obligation at all. Not a rounding error: for the thirteen
     * 2025 Inspire Change grants this is currently all of them, and a coverage
     * figure of "0 of 0 updates" would read as complete rather than as
     * nothing having been asked. Never year-filtered -- a grant with no
     * period has no year to filter on, and dropping it when a year is chosen
     * would hide exactly the grants that most need chasing.
     */
    db
      .prepare(
        `SELECT w.program_id AS programId, COUNT(*) AS n
           FROM awards w
          WHERE w.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM report_periods rp
                             WHERE rp.award_id = w.id AND rp.deleted_at IS NULL)
          GROUP BY w.program_id`,
      )
      .all<{ programId: string; n: number }>(),
  ]);

  const neverAskedBy = new Map<string, number>(
    (neverAsked.results ?? []).map((r) => [r.programId, r.n]),
  );

  const byProgram = new Map<string, ImpactProgram>();
  for (const c of coverage.results ?? []) {
    const id = c.programId as string;
    byProgram.set(id, {
      programId: id,
      programName: c.programName as string,
      metrics: [],
      obligations: (c.obligations as number) ?? 0,
      accepted: (c.accepted as number) ?? 0,
      grantsNeverAsked: neverAskedBy.get(id) ?? 0,
      grants: (c.grants as number) ?? 0,
      totalAwardedCents: (c.totalAwardedCents as number) ?? 0,
    });
  }

  for (const m of metrics.results ?? []) {
    const program = byProgram.get(m.programId as string);
    if (!program) continue;
    const answered = (m.answered as number) ?? 0;
    program.metrics.push({
      metricDefinitionId: m.metricDefinitionId as string,
      label: m.label as string,
      metricType: m.metricType as string,
      unit: (m.unit as string | null) ?? null,
      /*
       * SUM over no rows is NULL in SQLite, not 0, which is what makes
       * "nobody has told us yet" distinguishable from "0 people served" --
       * different facts, and the second is a libel on thirteen nonprofits.
       *
       * This was written as `answered === 0 ? null : ...`. A mutation run
       * showed that guard changes nothing: SUM has already produced NULL, and
       * the branch would also have to NOT fire for a grantee who genuinely
       * answered zero. It is gone rather than kept as decoration, and the
       * behaviour is pinned by tests from both directions instead.
       */
      total: (m.total as number | null) ?? null,
      answered,
    });
  }

  return {
    generatedAt: nowIso,
    year,
    years: (years.results ?? []).map((r) => r.y).filter((y) => y != null),
    programs: [...byProgram.values()],
  };
}
