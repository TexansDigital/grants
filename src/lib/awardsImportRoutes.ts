/**
 * The awards import, reachable.
 *
 * planAwardImport and applyAwardImport were written and tested and had no way
 * in -- the same state generateReportPeriods was in. Without a path to run
 * them there is nothing to report ON: no awards, so no report periods, so
 * nothing a grantee can file.
 *
 * A SCREEN RATHER THAN A SCRIPT, which is a departure from how the metrics
 * import works, for two reasons.
 *
 * The first is correctness. planAwardImport is real database work -- matching
 * organizations on EIN, deciding which rows create a user, linking year two of
 * a multi-year grant to year one -- and it resolves in file order, remembering
 * what it decided. A Node script cannot call a D1 binding, so a script version
 * would have to reimplement all of that against raw SQL, and a second
 * implementation of matching rules is one that drifts from the tested one.
 * The metrics script gets away with it because only its PARSER is shared; the
 * writes there are four columns of configuration.
 *
 * The second is that this is data, not configuration. It creates
 * organizations, users and financial records for real nonprofits. That
 * deserves a plan somebody reads and confirms, not a flag on a command line.
 *
 * THE APPLY STEP RE-PLANS FROM THE FILE. It never accepts a plan from the
 * client. A plan is a set of decisions about which organizations exist and
 * which rows create users; accepting one over HTTP would let a caller hand
 * back a plan that creates an award against any organization it names.
 */

import type { RequestContext, Session } from '../types';
import { AppError } from './errors';
import { parseAwardsCsv, formatAwardReport } from '../import/awards';
import type { AwardParseResult } from '../import/awards';
import { planAwardImport, applyAwardImport } from '../import/importAwards';
import type { ImportPlan } from '../import/importAwards';

/**
 * The largest file this will look at.
 *
 * A year of awards is tens of kilobytes. A megabyte of CSV is a mistake --
 * the wrong file, or an export that included every application ever -- and
 * refusing it with a clear message beats parsing 40,000 rows and presenting a
 * plan nobody can read.
 */
export const MAX_CSV_BYTES = 1_000_000;

function assertAdmin(session: Session): void {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can import awards.', {
      internalMessage: `awards import reached by role ${session.role}`,
      severity: 'warn',
    });
  }
}

function readCsv(body: Record<string, unknown>): string {
  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (csv.trim() === '') {
    throw new AppError('VALIDATION_FAILED', 'There was nothing in that file.', {
      internalMessage: 'awards import called with an empty csv field',
      severity: 'warn',
    });
  }
  // Bytes, not characters: a file of accented organization names is longer in
  // UTF-8 than its length suggests, and the limit is about payload size.
  const bytes = new TextEncoder().encode(csv).length;
  if (bytes > MAX_CSV_BYTES) {
    throw new AppError(
      'VALIDATION_FAILED',
      `That file is ${Math.round(bytes / 1000)} KB. The limit is ` +
        `${MAX_CSV_BYTES / 1000} KB — this is meant for a cycle of awards, ` +
        'not a full export.',
      { internalMessage: `awards csv ${bytes} bytes`, severity: 'warn' },
    );
  }
  return csv;
}

export interface ImportPreview {
  parse: {
    ok: boolean;
    rows: number;
    issues: AwardParseResult['issues'];
    unknownColumns: string[];
    /** The same text the command-line report would print. */
    report: string;
  };
  /** Null when the file did not parse well enough to plan anything. */
  plan: {
    ok: boolean;
    summary: ImportPlan['summary'];
    rows: {
      reference: string;
      organization: string;
      kind: 'create' | 'skip' | 'blocked';
      reason: string | null;
      amountCents: number;
      createsOrganization: boolean;
      createsUser: boolean;
    }[];
  } | null;
}

/** What a plan row looks like to somebody reading it before they commit. */
function describe(plan: ImportPlan): NonNullable<ImportPreview['plan']> {
  return {
    ok: plan.ok,
    summary: plan.summary,
    rows: plan.rows.map((r) => ({
      reference: r.award.externalReference,
      organization: r.award.organizationName,
      kind: r.kind,
      reason: r.kind === 'create' ? null : r.reason,
      amountCents: r.award.awardedAmountCents,
      createsOrganization: r.kind === 'create' && r.createdOrganization,
      createsUser: r.kind === 'create' && r.createdUser,
    })),
  };
}

/**
 * Read the file and say what would happen. Writes nothing.
 */
export async function previewAwardImport(
  db: D1Database,
  session: Session,
  body: Record<string, unknown>,
): Promise<ImportPreview> {
  assertAdmin(session);
  const parsed = parseAwardsCsv(readCsv(body));

  const preview: ImportPreview = {
    parse: {
      ok: parsed.ok,
      rows: parsed.awards.length,
      issues: parsed.issues,
      unknownColumns: parsed.unknownColumns,
      report: formatAwardReport(parsed),
    },
    plan: null,
  };

  /*
   * Plan the CLEAN rows, even when other rows are broken.
   *
   * Showing "eleven would import, two are unreadable" in one pass is what lets
   * somebody fix the two; refusing to plan until the file is perfect finds the
   * problems one round trip at a time.
   *
   * The filter matters. parseAwardsCsv pushes EVERY row it gets to the end of,
   * issues and all -- a row with an unreadable amount arrives with zero cents.
   * Planning those would show a $0 award as "would be created", which is a
   * plan that will never run: the import refuses any file with issues.
   */
  const broken = new Set(parsed.issues.map((i) => i.rowNumber));
  const clean = parsed.awards.filter((a) => !broken.has(a.rowNumber));

  if (clean.length > 0) {
    preview.plan = describe(await planAwardImport(db, clean));
  }
  return preview;
}

export interface ApplyResult {
  awardsCreated: number;
  organizationsCreated: number;
  usersCreated: number;
  skipped: number;
}

/**
 * Import the file.
 *
 * Re-parses and re-plans from the CSV rather than trusting anything the client
 * sends back, then refuses unless the plan is clean. applyAwardImport already
 * refuses a blocked plan; this checks first so the message names the file's
 * problem rather than an internal state.
 */
export async function runAwardImport(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  body: Record<string, unknown>,
): Promise<ApplyResult> {
  assertAdmin(session);
  const parsed = parseAwardsCsv(readCsv(body));

  if (!parsed.ok) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This file has problems that need fixing before anything is imported.',
      { internalMessage: `awards csv had ${parsed.issues.length} issue(s)`, severity: 'warn' },
    );
  }
  if (parsed.awards.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'There were no award rows in that file.', {
      internalMessage: 'awards csv parsed to zero rows',
      severity: 'warn',
    });
  }

  const plan = await planAwardImport(db, parsed.awards);
  if (!plan.ok) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${plan.summary.blocked} row(s) cannot be imported. Fix them and try again.`,
      { internalMessage: 'awards plan blocked', severity: 'warn' },
    );
  }

  return applyAwardImport(db, ctx, plan);
}
