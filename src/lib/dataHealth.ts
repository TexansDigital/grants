/**
 * What is wrong with the data, right now.
 *
 * A worklist, not a report. Every row is something a person has to go and fix,
 * and the screen exists so that nobody discovers a grant with no W-9 in the
 * week finance is trying to pay it.
 *
 * READ-ONLY, DELIBERATELY. No mutations, so no audit rows -- see audit.ts on
 * why a write without one is not allowed here or anywhere. "Mark W-9 received"
 * from a list is a write to a financial record and wants its own confirmation
 * and its own audit row; it is not a checkbox on a triage screen.
 *
 * ADMIN ONLY. A reviewer is scoped to the applications assigned to them. This
 * shows every organization's award compliance and EIN state across every
 * program, which is exactly the aggregate a scoped role must not have.
 *
 * SEVERITY IS A CLAIM, NOT DECORATION.
 *   blocking       money or an obligation cannot move until this is fixed
 *   attention      wrong, or about to be, but nothing is stuck on it
 *   informational  expected states worth being able to see, not faults
 *
 * Each check is one statement, and they all go out in a single db.batch().
 * D1 is single-threaded, and twelve round trips to draw one screen would be
 * twelve chances for the screen to be internally inconsistent.
 */

import type { Session } from '../types';
import { AppError } from './errors';
import { findDuplicateCandidates } from './merge';
import { NEEDS_PERIODS_SQL } from './reportPeriods';
import { nowIso } from './time';

/** What a row points at. The UI turns this into a link where a screen exists. */
export type HealthKind =
  | 'award'
  | 'organization'
  | 'application'
  | 'report_period'
  | 'attachment';

export type Severity = 'blocking' | 'attention' | 'informational';

export interface HealthRow {
  id: string;
  kind: HealthKind;
  /** Who it is about -- almost always the organization. */
  title: string;
  /** Enough to act on without opening anything. */
  detail: string;
  /**
   * Money stays integer cents all the way to the display edge, per CLAUDE.md.
   * Null where the row is not about an amount.
   */
  amountCents: number | null;
}

export interface HealthCheck {
  key: string;
  label: string;
  /** What a person should do about it, in one line. */
  guidance: string;
  severity: Severity;
  /** The true total, not the length of `rows`. */
  count: number;
  rows: HealthRow[];
  /** True when `count` exceeds what `rows` carries. */
  truncated: boolean;
}

export interface HealthReport {
  generatedAt: string;
  checks: HealthCheck[];
  /** Totals by severity, so the header can say it before the detail. */
  blocking: number;
  attention: number;
}

/**
 * How many rows travel with each check.
 *
 * The COUNT is always exact -- see the window function below -- so this caps
 * the payload, not the truth. At 25 to 100 awards a year a check that trips
 * fifty times is a systemic problem, and the fifty-first row will not be what
 * tells you that.
 */
export const ROWS_PER_CHECK = 50;

/**
 * An attachment is legitimately unclaimed while its draft is open. A week is
 * long past the point where that is the explanation.
 */
export const UNCLAIMED_AFTER_DAYS = 7;

function assertAdmin(session: Session): void {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can do that.', {
      internalMessage: `data health reached by role ${session.role}`,
      severity: 'warn',
    });
  }
}

/*
 * Organizations worth flagging.
 *
 * An organization that exists because somebody started a draft and wandered off
 * has no EIN, and that is not a data-health problem -- it is an empty account.
 * Flagging it buries the ones that matter. Only organizations that actually
 * submitted something or hold a grant are in scope.
 */
const ORG_IN_PLAY = `(
  EXISTS (SELECT 1 FROM applications ap
           WHERE ap.organization_id = o.id
             AND ap.submitted_at IS NOT NULL
             AND ap.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM awards aw
              WHERE aw.organization_id = o.id AND aw.deleted_at IS NULL)
)`;

interface CheckSpec {
  key: string;
  label: string;
  guidance: string;
  severity: Severity;
  kind: HealthKind;
  sql: string;
  binds: unknown[];
  row: (r: Record<string, unknown>) => Omit<HealthRow, 'kind'>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * `COUNT(*) OVER ()` rather than a second COUNT query.
 *
 * SQLite applies LIMIT last, after window functions, so every returned row
 * carries the size of the FULL result set. One statement per check instead of
 * two, and no chance of the count and the rows disagreeing because something
 * changed between them. A test pins this, because it is the sort of thing that
 * looks like an implementation detail right up until the header says 3 and the
 * list has 50 entries.
 */
function specs(now: string): CheckSpec[] {
  const unclaimedBefore = new Date(
    Date.parse(now) - UNCLAIMED_AFTER_DAYS * 86400_000,
  ).toISOString();

  const award = (where: string) => `
    SELECT a.id            AS id,
           o.legal_name    AS legal_name,
           a.awarded_amount_cents AS cents,
           a.awarded_at    AS awarded_at,
           a.term_start    AS term_start,
           a.term_end      AS term_end,
           a.source_system AS source_system,
           COUNT(*) OVER () AS match_count
      FROM awards a
      JOIN organizations o ON o.id = a.organization_id
     WHERE a.deleted_at IS NULL AND ${where}
     ORDER BY a.awarded_at DESC
     LIMIT ?`;

  const org = (where: string) => `
    SELECT o.id          AS id,
           o.legal_name  AS legal_name,
           o.ein         AS ein,
           o.ein_verified_name AS verified_name,
           COUNT(*) OVER () AS match_count
      FROM organizations o
     WHERE o.deleted_at IS NULL AND o.status = 'active'
       AND ${ORG_IN_PLAY} AND ${where}
     ORDER BY o.legal_name
     LIMIT ?`;

  return [
    // ---- blocking ---------------------------------------------------------
    {
      key: 'award_no_w9',
      label: 'Active grants with no W-9',
      guidance: 'Finance cannot disburse without one. Collect it at acceptance.',
      severity: 'blocking',
      kind: 'award',
      sql: award(`a.status = 'active' AND a.w9_received_at IS NULL`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `awarded ${str(r.awarded_at).slice(0, 10)}`,
        amountCents: num(r.cents),
      }),
    },
    {
      key: 'award_no_agreement',
      label: 'Active grants with no signed agreement',
      guidance: 'The grant is live and nothing is signed for it.',
      severity: 'blocking',
      kind: 'award',
      sql: award(`a.status = 'active' AND a.agreement_signed_at IS NULL`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `awarded ${str(r.awarded_at).slice(0, 10)}`,
        amountCents: num(r.cents),
      }),
    },
    {
      /*
       * The silent one. A grant with a term and no report periods is a grantee
       * nobody will ever ask for a report, and nothing anywhere else in the
       * system will ever mention it -- the compliance desk lists periods, and
       * this award has none to list.
       */
      key: 'award_no_report_periods',
      label: 'Grants that will never be asked to report',
      guidance:
        'Term dates are set but no report periods exist, so no report is ever due. ' +
        'Reporting has a button that creates them.',
      severity: 'blocking',
      kind: 'award',
      /*
       * The predicate comes from reportPeriods.ts, which is also what the
       * generator acts on. Two copies would drift, and the first anyone would
       * know is this screen saying seven beside a button that fixes five.
       * NEEDS_PERIODS_SQL already carries `a.deleted_at IS NULL`; award()
       * repeats it harmlessly.
       */
      sql: award(NEEDS_PERIODS_SQL),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `term ${str(r.term_start).slice(0, 10)} to ${str(r.term_end).slice(0, 10)}`,
        amountCents: num(r.cents),
      }),
    },
    {
      key: 'report_period_no_form',
      label: 'Report obligations with no form',
      guidance:
        'The grantee cannot file. Publishing a report form attaches it to these.',
      severity: 'blocking',
      kind: 'report_period',
      sql: `
        SELECT rp.id AS id,
               o.legal_name AS legal_name,
               rp.label AS label,
               rp.due_date AS due_date,
               COUNT(*) OVER () AS match_count
          FROM report_periods rp
          JOIN awards a ON a.id = rp.award_id
          JOIN organizations o ON o.id = a.organization_id
         WHERE rp.deleted_at IS NULL
           AND rp.form_definition_id IS NULL
           AND rp.status NOT IN ('accepted','waived')
           AND a.deleted_at IS NULL
         ORDER BY rp.due_date
         LIMIT ?`,
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `${str(r.label)}, due ${str(r.due_date).slice(0, 10)}`,
        amountCents: null,
      }),
    },
    {
      key: 'organization_no_ein',
      label: 'Organizations with no EIN',
      guidance: 'Required before an award. These have applied or hold a grant.',
      severity: 'blocking',
      kind: 'organization',
      sql: org(`(o.ein IS NULL OR o.ein = '')`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: 'no EIN on record',
        amountCents: null,
      }),
    },

    // ---- attention --------------------------------------------------------
    {
      key: 'ein_unverified',
      label: 'EINs never checked against the IRS file',
      guidance: 'A mismatch is a flag for a human, never an automatic rejection.',
      severity: 'attention',
      kind: 'organization',
      sql: org(`o.ein IS NOT NULL AND o.ein <> '' AND o.ein_verified_at IS NULL`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `EIN ${str(r.ein)}, never verified`,
        amountCents: null,
      }),
    },
    {
      /*
       * Names legitimately differ -- a DBA, a recent legal change, an IRS file
       * that lags. This is a prompt to look, which is why it is `attention`
       * and not `blocking`, and why the comparison is deliberately crude.
       */
      key: 'ein_name_mismatch',
      label: 'Legal name differs from the IRS record',
      guidance: 'Often a DBA or a lagging IRS file. Worth one look each.',
      severity: 'attention',
      kind: 'organization',
      /*
       * `IS NOT NULL` is redundant and stays anyway. SQL's three-valued logic
       * already excludes a NULL verified name -- NULL <> 'x' is NULL, not true
       * -- so removing the guard changes no result, and a mutation run
       * confirmed it as equivalent rather than as a gap. It is kept because
       * the next person to edit this predicate should not have to know that
       * rule to see that an un-fetched name is deliberately not a mismatch.
       */
      sql: org(
        `o.ein_verified_name IS NOT NULL
         AND lower(trim(o.ein_verified_name)) <> lower(trim(o.legal_name))`,
      ),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `IRS says "${str(r.verified_name)}"`,
        amountCents: null,
      }),
    },
    {
      key: 'award_no_term',
      label: 'Grants with no term dates',
      guidance: 'Report periods cannot be generated until these are set.',
      severity: 'attention',
      kind: 'award',
      sql: award(
        `a.status IN ('pending','active')
         AND (a.term_start IS NULL OR a.term_end IS NULL)`,
      ),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `awarded ${str(r.awarded_at).slice(0, 10)}, no term`,
        amountCents: num(r.cents),
      }),
    },
    {
      key: 'award_no_media_release',
      label: 'Active grants with no media release',
      guidance: 'Needed before the grant appears in anything public.',
      severity: 'attention',
      kind: 'award',
      sql: award(`a.status = 'active' AND a.media_release_at IS NULL`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `awarded ${str(r.awarded_at).slice(0, 10)}`,
        amountCents: num(r.cents),
      }),
    },

    // ---- informational ----------------------------------------------------
    {
      /*
       * DECISIONS.md 25: removing a file before submit unclaims the row rather
       * than deleting it, and said the orphans would accumulate. This is where
       * that shows up, rather than in a surprise storage bill.
       */
      key: 'unclaimed_attachments',
      label: 'Uploaded files attached to nothing',
      guidance: `Normal while a draft is open; these are over ${UNCLAIMED_AFTER_DAYS} days old.`,
      severity: 'informational',
      kind: 'attachment',
      sql: `
        SELECT at.id AS id,
               at.filename AS filename,
               COALESCE(o.legal_name, '(no organization)') AS legal_name,
               at.uploaded_at AS uploaded_at,
               at.size_bytes AS size_bytes,
               COUNT(*) OVER () AS match_count
          FROM attachments at
          LEFT JOIN organizations o ON o.id = at.organization_id
         WHERE at.deleted_at IS NULL
           AND at.parent_id IS NULL
           AND at.uploaded_at < ?
         ORDER BY at.uploaded_at
         LIMIT ?`,
      binds: [unclaimedBefore, ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `${str(r.filename)}, uploaded ${str(r.uploaded_at).slice(0, 10)}`,
        amountCents: null,
      }),
    },
    {
      /*
       * The schema guarantees these can be explained: an award carries
       * `application_id IS NOT NULL OR source_system IS NOT NULL`, so a grant
       * with no application always says where it came from instead.
       */
      key: 'award_no_application',
      label: 'Grants with no application behind them',
      guidance: 'Expected for imported history. Not a fault.',
      severity: 'informational',
      kind: 'award',
      sql: award(`a.application_id IS NULL`),
      binds: [ROWS_PER_CHECK],
      row: (r) => ({
        id: str(r.id),
        title: str(r.legal_name),
        detail: `from ${str(r.source_system) || 'an unnamed source'}, awarded ${str(r.awarded_at).slice(0, 10)}`,
        amountCents: num(r.cents),
      }),
    },
  ];
}

/**
 * Run every check and return them in severity order.
 *
 * Checks that trip nothing are KEPT, with a count of zero. A health screen that
 * hides its passing checks cannot be read as "and these were looked at" -- the
 * absence of a row becomes ambiguous between clean and not-run.
 */
export async function dataHealth(
  db: D1Database,
  session: Session,
  opts: { now?: string } = {},
): Promise<HealthReport> {
  assertAdmin(session);
  const now = opts.now ?? nowIso();
  const list = specs(now);

  const results = await db.batch<Record<string, unknown>>(
    list.map((s) => db.prepare(s.sql).bind(...s.binds)),
  );

  const checks: HealthCheck[] = list.map((spec, i) => {
    const rows = results[i]?.results ?? [];
    const first = rows[0];
    const count = first && typeof first.match_count === 'number' ? first.match_count : 0;
    return {
      key: spec.key,
      label: spec.label,
      guidance: spec.guidance,
      severity: spec.severity,
      count,
      rows: rows.map((r) => ({ kind: spec.kind, ...spec.row(r) })),
      truncated: count > rows.length,
    };
  });

  /*
   * Duplicates are not a query here. findDuplicateCandidates already holds the
   * matching rules -- normalised names, EIN grouping, the merge-target walk --
   * and a second, simpler copy of them on this screen would drift from the one
   * the merge tool actually uses, and disagree with it in front of somebody
   * about to merge two records.
   */
  const duplicates = await findDuplicateCandidates(db, session, { limit: ROWS_PER_CHECK });
  checks.push({
    key: 'duplicate_organizations',
    label: 'Possible duplicate organizations',
    guidance: 'Merge reunites a grantee with the grants and reports they hold.',
    severity: 'informational',
    count: duplicates.length,
    rows: duplicates.map((g) => ({
      id: g.organizations[0]?.id ?? '',
      kind: 'organization' as const,
      title: g.organizations.map((o) => o.legalName).join(' · '),
      detail: g.reason === 'same_ein' ? `same EIN ${g.key}` : 'similar name',
      amountCents: null,
    })),
    truncated: false,
  });

  const RANK: Record<Severity, number> = { blocking: 0, attention: 1, informational: 2 };
  checks.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.key.localeCompare(b.key));

  const total = (s: Severity) =>
    checks.filter((c) => c.severity === s).reduce((n, c) => n + c.count, 0);

  return {
    generatedAt: now,
    checks,
    blocking: total('blocking'),
    attention: total('attention'),
  };
}
