/**
 * The numbers, and the export that carries them out of here.
 *
 * WHO THIS IS FOR. CLAUDE.md is blunt about it: "Executives never log in, so
 * the export is the product for them and must stand alone." Everything here is
 * shaped by that. A figure that needs somebody to explain it is a figure that
 * will be explained wrongly in a board meeting nobody from this project
 * attends.
 *
 * SO EVERY AGGREGATE SAYS WHAT IT EXCLUDES. "Total awarded" is not one number,
 * it is a number plus a rule about cancelled grants and pending ones, and the
 * rule travels with it into the CSV rather than living in this comment.
 *
 * MONEY STAYS IN CENTS all the way to the formatting call. A dashboard is
 * exactly where somebody divides by 100 early, and then a sum of rounded
 * halves disagrees with the ledger by a few dollars that nobody can find.
 *
 * WHAT IS NOT HERE, and must not be reported as missing by accident:
 * DISBURSEMENT. There is no payments table in this schema yet, so "committed
 * versus disbursed" -- which CLAUDE.md asks for -- cannot be computed. The
 * dashboard says so in words rather than showing committed twice under two
 * headings.
 */

import type { Session } from '../types';
import { notFound } from './errors';
import { formatCents, MAX_CENTS } from './money';
import { disbursementByProgram, type DisbursementLine } from './payments';

function assertAdmin(session: Session): void {
  // Executives have no in-app access by design and reviewers have no business
  // with portfolio totals. 404 rather than 403, like everywhere else.
  if (session.role !== 'admin') throw notFound('dashboard');
}

export interface AwardTotalRow {
  fiscalYear: number | null;
  programId: string;
  programName: string;
  cycleId: string | null;
  cycleName: string | null;
  awards: number;
  committedCents: number;
  /** Smallest and largest, which a mean alone hides. */
  smallestCents: number | null;
  largestCents: number | null;
}

/**
 * Awarded money, by fiscal year, program and cycle.
 *
 * CANCELLED AWARDS ARE EXCLUDED; pending ones are included. A rescinded grant
 * is not a commitment, and money offered but not yet accepted is still money
 * the Foundation cannot offer to somebody else.
 *
 * THE RANGE IS CARRIED ALONGSIDE THE TOTAL because a portfolio of forty
 * $25,000 grants and one of thirty-nine $10,000 grants plus a $600,000 grant
 * have similar totals and are completely different programs. A board reading
 * only the total learns the wrong thing.
 */
export async function awardTotals(db: D1Database, session: Session): Promise<AwardTotalRow[]> {
  assertAdmin(session);
  const { results } = await db
    .prepare(
      `SELECT p.fiscal_year AS fiscalYear, p.id AS programId, p.name AS programName,
              w.cycle_id AS cycleId, c.name AS cycleName,
              COUNT(w.id) AS awards,
              COALESCE(SUM(w.awarded_amount_cents), 0) AS committedCents,
              MIN(w.awarded_amount_cents) AS smallestCents,
              MAX(w.awarded_amount_cents) AS largestCents
         FROM awards w
         JOIN programs p ON p.id = w.program_id
         LEFT JOIN cycles c ON c.id = w.cycle_id
        WHERE w.deleted_at IS NULL
          AND w.status <> 'cancelled'
          AND p.deleted_at IS NULL
        GROUP BY p.fiscal_year, p.id, w.cycle_id
        ORDER BY p.fiscal_year DESC, p.name, c.opens_at`,
    )
    .all<AwardTotalRow>();
  return results ?? [];
}

export interface FunnelRow {
  programId: string;
  programName: string;
  cycleId: string;
  cycleName: string;
  closesAt: string;
  received: number;
  underReview: number;
  awarded: number;
  declined: number;
  withdrawn: number;
  /** Awarded / received, in basis points. Integers, like everything else. */
  successRateBp: number | null;
}

/**
 * Applications received versus funded, per cycle.
 *
 * DRAFTS ARE NOT "RECEIVED". A draft somebody started and abandoned is not an
 * application, and counting it makes the success rate look worse every year
 * the form gets easier to start.
 *
 * THE RATE IS IN BASIS POINTS, not a rounded percentage, for the same reason
 * money is in cents: 17 awards from 63 applications is 26.98%, and a column of
 * numbers each rounded to 27% no longer sums to anything.
 */
export async function applicationFunnel(db: D1Database, session: Session): Promise<FunnelRow[]> {
  assertAdmin(session);
  const { results } = await db
    .prepare(
      `SELECT p.id AS programId, p.name AS programName,
              c.id AS cycleId, c.name AS cycleName, c.closes_at AS closesAt,
              COUNT(a.id) AS received,
              SUM(CASE WHEN a.status IN ('submitted','under_review') THEN 1 ELSE 0 END) AS underReview,
              SUM(CASE WHEN a.status = 'awarded'   THEN 1 ELSE 0 END) AS awarded,
              SUM(CASE WHEN a.status = 'declined'  THEN 1 ELSE 0 END) AS declined,
              SUM(CASE WHEN a.status = 'withdrawn' THEN 1 ELSE 0 END) AS withdrawn
         FROM cycles c
         JOIN programs p ON p.id = c.program_id
         LEFT JOIN applications a
           ON a.cycle_id = c.id
          AND a.deleted_at IS NULL
          AND a.submitted_at IS NOT NULL
        WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY c.closes_at DESC`,
    )
    .all<Omit<FunnelRow, 'successRateBp'>>();
  return (results ?? []).map((r) => ({
    ...r,
    successRateBp: r.received === 0 ? null : Math.round((r.awarded * 10000) / r.received),
  }));
}

export interface ComplianceRow {
  programId: string;
  programName: string;
  scheduled: number;
  open: number;
  submitted: number;
  revisionsRequested: number;
  accepted: number;
  waived: number;
  overdue: number;
  total: number;
  /** Accepted or waived, over everything due. Basis points. */
  complianceRateBp: number | null;
}

/**
 * Report compliance, per program.
 *
 * OVERDUE IS COMPUTED, NOT STORED. A period is overdue when its due date has
 * passed and it is neither accepted nor waived -- which is a fact about today
 * rather than a state somebody has to remember to write. A stored flag drifts
 * the moment a nightly job does not run.
 *
 * WAIVED COUNTS AS COMPLIANT. Staff decided the report was not required; that
 * is a deliberate act with a reason attached, and counting it as a failure
 * would make the honest thing look worse than quietly leaving it open.
 *
 * A CANCELLED AWARD IS NOT A COMPLIANCE FAILURE, and this join used to make it
 * one. When a grantee refuses an award, 0020 records it as `cancelled` -- but
 * any report periods already generated from the award term stay behind, in
 * `scheduled`, with due dates that eventually pass. Counted, they sit in the
 * overdue column forever for a grant nobody ever took, and they drag the
 * program's compliance rate down with a denominator that includes reports no
 * one was ever going to file. Excluded in the ON clause, not the WHERE, so a
 * program whose only award was cancelled still appears with a row of zeroes
 * rather than vanishing from the dashboard.
 */
export async function reportCompliance(
  db: D1Database,
  session: Session,
  nowIsoStr: string,
): Promise<ComplianceRow[]> {
  assertAdmin(session);
  const { results } = await db
    .prepare(
      `SELECT p.id AS programId, p.name AS programName,
              SUM(CASE WHEN rp.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
              SUM(CASE WHEN rp.status = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN rp.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
              SUM(CASE WHEN rp.status = 'revisions_requested' THEN 1 ELSE 0 END) AS revisionsRequested,
              SUM(CASE WHEN rp.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN rp.status = 'waived' THEN 1 ELSE 0 END) AS waived,
              SUM(CASE WHEN rp.due_date < ?
                         AND rp.status NOT IN ('accepted','waived')
                        THEN 1 ELSE 0 END) AS overdue,
              COUNT(rp.id) AS total
         FROM programs p
         LEFT JOIN awards w ON w.program_id = p.id AND w.deleted_at IS NULL
                                AND w.status <> 'cancelled'
         LEFT JOIN report_periods rp ON rp.award_id = w.id AND rp.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.name`,
    )
    .bind(nowIsoStr)
    .all<Omit<ComplianceRow, 'complianceRateBp'>>();
  return (results ?? []).map((r) => ({
    ...r,
    complianceRateBp:
      r.total === 0 ? null : Math.round(((r.accepted + r.waived) * 10000) / r.total),
  }));
}

export interface MetricRow {
  programId: string;
  programName: string;
  metricDefinitionId: string;
  label: string;
  metricType: string;
  unit: string | null;
  /** How many accepted reports carried a value. The denominator, stated. */
  reports: number;
  /** Null for a text metric, which is never aggregated. */
  total: number | null;
}

/**
 * Impact metrics, aggregated per program.
 *
 * ONLY ACCEPTED REPORTS COUNT. A submitted-but-unreviewed number has not been
 * checked by anybody, and a board figure built from unchecked numbers is one
 * the Foundation will be asked to defend.
 *
 * TEXT METRICS ARE NOT AGGREGATED, and return null rather than zero. "Describe
 * the populations served" has no sum, and a zero in that row reads as "we
 * served nobody".
 *
 * THE DENOMINATOR TRAVELS WITH THE TOTAL. "4,200 people served" from six
 * reports out of forty awards is a different sentence from the same number out
 * of forty, and only one of them belongs in a board pack unqualified.
 */
export async function impactMetrics(db: D1Database, session: Session): Promise<MetricRow[]> {
  assertAdmin(session);
  const { results } = await db
    .prepare(
      `SELECT p.id AS programId, p.name AS programName,
              md.id AS metricDefinitionId, md.label, md.metric_type AS metricType, md.unit,
              COUNT(mv.id) AS reports,
              -- EXPLICIT, THOUGH REDUNDANT TODAY. A mutation run showed that
              -- removing this branch changes nothing: a text metric's value
              -- lands in value_text, so SUM(value_int) over it is NULL anyway,
              -- confirmed against a text metric that really had an accepted
              -- value. It stays because the redundancy is accidental. The day
              -- somebody writes COALESCE(SUM(value_int), SUM(value_real)) in
              -- the ELSE -- a plausible "handle both" edit -- a written answer
              -- starts producing a number, and "Populations served: 0" reads
              -- as "we served nobody".
              CASE WHEN md.metric_type = 'text' THEN NULL
                   WHEN md.metric_type = 'decimal' THEN SUM(mv.value_real)
                   ELSE SUM(mv.value_int)
              END AS total
         FROM metric_definitions md
         JOIN programs p ON p.id = md.program_id
         LEFT JOIN metric_values mv ON mv.metric_definition_id = md.id
         LEFT JOIN report_submissions rs
           ON rs.id = mv.report_submission_id
          AND rs.accepted_at IS NOT NULL
          AND rs.deleted_at IS NULL
        WHERE md.deleted_at IS NULL AND p.deleted_at IS NULL
          AND (mv.id IS NULL OR rs.id IS NOT NULL)
        GROUP BY md.id
        ORDER BY p.name, md.sort_order, md.label`,
    )
    .all<MetricRow>();
  return results ?? [];
}

export interface Dashboard {
  generatedAt: string;
  awardTotals: AwardTotalRow[];
  funnel: FunnelRow[];
  compliance: ComplianceRow[];
  metrics: MetricRow[];
  /** Committed, scheduled and paid, per program. */
  disbursement: DisbursementLine[];
  /**
   * What this dashboard cannot answer, carried in the payload rather than left
   * for somebody to notice.
   *
   * It used to name disbursement, because there was no payment ledger. There
   * is one now, and this list is empty -- kept rather than removed, because an
   * export that can state its own gaps is worth more than one that has none
   * today and quietly grows some later.
   */
  notAvailable: string[];
}

export async function buildDashboard(
  db: D1Database,
  session: Session,
  nowIsoStr: string,
): Promise<Dashboard> {
  assertAdmin(session);
  const [totals, funnel, compliance, metrics, disbursement] = await Promise.all([
    awardTotals(db, session),
    applicationFunnel(db, session),
    reportCompliance(db, session, nowIsoStr),
    impactMetrics(db, session),
    disbursementByProgram(db, session),
  ]);
  return {
    generatedAt: nowIsoStr,
    awardTotals: totals,
    funnel,
    compliance,
    metrics,
    disbursement,
    notAvailable: [],
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function cell(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Format a reported currency metric, or say plainly that it cannot be one.
 *
 * Grantee-supplied, so the range is whatever somebody typed into a report.
 */
function safeMoney(total: number): string {
  const cents = Math.round(total);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    return `${cents} (outside the range we can total)`;
  }
  return formatCents(cents);
}

/** Basis points to a percentage string, at the display edge only. */
export function formatRate(bp: number | null): string {
  return bp === null ? '' : `${(bp / 100).toFixed(1)}%`;
}

/**
 * The whole dashboard as one CSV.
 *
 * ONE FILE, SECTIONED, rather than four downloads. The person receiving this
 * opens it once, and four files in a Downloads folder is four chances to send
 * a board the wrong one.
 *
 * MONEY IS WRITTEN TWICE: formatted for reading, and in raw cents for anybody
 * who has to add it up. A spreadsheet that only carries "$25,000.00" is a
 * spreadsheet somebody re-types.
 */
export function dashboardCsv(d: Dashboard): string {
  const lines: string[] = [];
  const row = (...cells: (string | number | null)[]) => lines.push(cells.map(cell).join(','));

  row('Houston Texans Foundation — grants summary');
  row('Generated', d.generatedAt);
  for (const note of d.notAvailable) row('Not included', note);
  row('');

  row('AWARDS');
  row('Fiscal year', 'Program', 'Cycle', 'Awards', 'Committed', 'Committed (cents)',
      'Smallest', 'Largest');
  for (const r of d.awardTotals) {
    row(
      r.fiscalYear, r.programName, r.cycleName ?? '(no cycle)', r.awards,
      formatCents(r.committedCents), r.committedCents,
      r.smallestCents === null ? '' : formatCents(r.smallestCents),
      r.largestCents === null ? '' : formatCents(r.largestCents),
    );
  }
  row('');
  // Excluded rules travel WITH the numbers, not in a covering email.
  row('Cancelled awards are excluded. Awards not yet accepted are included.');
  row('');

  row('MONEY OUT');
  row('Program', 'Committed', 'Scheduled', 'Paid', 'Not yet scheduled',
      'Scheduled, not paid', 'Committed (cents)', 'Paid (cents)');
  for (const r of d.disbursement) {
    row(
      r.programName,
      formatCents(r.committedCents), formatCents(r.scheduledCents), formatCents(r.paidCents),
      formatCents(Math.max(0, r.committedCents - r.scheduledCents)),
      formatCents(Math.max(0, r.scheduledCents - r.paidCents)),
      r.committedCents, r.paidCents,
    );
  }
  row('');
  /*
   * THREE NUMBERS, NOT TWO, and the reason is on the row beneath them. Money
   * nobody has scheduled and money scheduled but unpaid are different problems
   * for different people, and one "outstanding" figure sends the wrong one
   * after it.
   */
  row(
    'Steward records payment schedules and what finance reports as paid. It does not ' +
      'move money. Cancelled payments are listed on an award but not counted here.',
  );
  row('');

  row('APPLICATIONS');
  row('Program', 'Cycle', 'Closed', 'Received', 'In review', 'Awarded', 'Declined',
      'Withdrawn', 'Funded rate');
  for (const r of d.funnel) {
    row(
      r.programName, r.cycleName, r.closesAt, r.received, r.underReview,
      r.awarded, r.declined, r.withdrawn, formatRate(r.successRateBp),
    );
  }
  row('');
  row('Drafts that were never submitted are not counted as received.');
  row('');

  row('GRANT REPORTS');
  row('Program', 'Scheduled', 'Open', 'Submitted', 'Revisions requested', 'Accepted',
      'Waived', 'Overdue', 'Total', 'Compliance');
  for (const r of d.compliance) {
    row(
      r.programName, r.scheduled, r.open, r.submitted, r.revisionsRequested,
      r.accepted, r.waived, r.overdue, r.total, formatRate(r.complianceRateBp),
    );
  }
  row('');
  row('Overdue means past its due date and neither accepted nor waived.');
  row('');

  row('IMPACT');
  row('Program', 'Metric', 'Unit', 'Reports counted', 'Total');
  for (const r of d.metrics) {
    row(
      r.programName, r.label, r.unit ?? '', r.reports,
      /*
       * NOT formatCents DIRECTLY. `metric_values.value_int` has no upper
       * CHECK, so one grantee typing a nine-digit "funds leveraged" figure
       * makes assertCents throw above MAX_CENTS -- and because this is the
       * CSV, GET /api/dashboard.csv then returned INTERNAL forever while the
       * JSON dashboard kept working. The only artefact executives receive
       * would break and nothing else would.
       *
       * An out-of-range figure is reported as itself with a note rather than
       * formatted, because the number IS the problem and hiding it behind an
       * error helps nobody find the report it came from.
       */
      r.total === null
        ? ''
        : r.metricType === 'currency'
          ? safeMoney(r.total)
          : r.total,
    );
  }
  row('');
  row('Only accepted reports are counted. Written answers are not totalled.');

  return `${lines.join('\r\n')}\r\n`;
}
