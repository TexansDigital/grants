/**
 * What an unfiled report does to a new application.
 *
 * `programs.compliance_policy` has been a column with nothing behind it since
 * Phase 0 -- correctly, because there were no reports to be overdue. There are
 * now, and this is the join between the two halves of the system: an
 * organization sitting on a report from last year meets that fact at the moment
 * they apply for the next grant, rather than after staff notice.
 *
 * THE POLICY BELONGS TO THE PROGRAM BEING APPLIED TO. The overdue report does
 * not have to. An organization that owes a report to any Foundation program is
 * delinquent to the Foundation, and a program that sets `block` is saying
 * "settle up first" -- not "settle up with me specifically". A program that
 * disagrees sets `ignore`, which is exactly what that setting is for.
 *
 * WHAT IS NEVER BLOCKED. A report already filed and waiting on staff is our
 * queue, not theirs; a waived one is finished; one not yet due is not late.
 * `isOverdue` in reportDue.ts is the single definition, shared with the staff
 * compliance desk, so the gate and the desk can never disagree about who is
 * late.
 *
 * AND IT NEVER BLOCKS SILENTLY. A refusal names every report it is refusing
 * over, with its due date and a way to get to it. "You are not eligible" with
 * no reason is how a nonprofit ends up emailing a program officer to ask what
 * they did wrong.
 */

import { AppError } from './errors';
import { nowIso } from './time';
import { isOverdue } from './reportDue';
import { resolveMergeTarget } from './identity';

export type CompliancePolicy = 'block' | 'warn' | 'ignore';
export type ComplianceDecision = 'allow' | 'warn' | 'block';

export interface OverdueReport {
  reportPeriodId: string;
  label: string;
  dueDate: string;
  daysLate: number;
  programName: string;
}

export interface ComplianceCheck {
  policy: CompliancePolicy;
  decision: ComplianceDecision;
  overdue: OverdueReport[];
  /** Plain language for the applicant. Null when there is nothing to say. */
  message: string | null;
}

function isPolicy(value: unknown): value is CompliancePolicy {
  return value === 'block' || value === 'warn' || value === 'ignore';
}

/** One sentence naming what is outstanding, in the order it came due. */
export function complianceMessage(
  overdue: readonly OverdueReport[],
  decision: ComplianceDecision,
): string | null {
  if (overdue.length === 0 || decision === 'allow') return null;

  const list = overdue
    .map((r) => `${r.label} for ${r.programName}, due ${r.dueDate.slice(0, 10)}`)
    .join('; ');

  if (decision === 'block') {
    return overdue.length === 1
      ? `Your organization has a grant report still outstanding: ${list}. ` +
          'Please file it before applying. Sign in at the reporting page to do that, ' +
          'or reply to this page’s contact address if you think this is wrong.'
      : `Your organization has ${overdue.length} grant reports still outstanding: ${list}. ` +
          'Please file them before applying, or get in touch if you think this is wrong.';
  }
  return overdue.length === 1
    ? `One grant report is still outstanding: ${list}. You can still apply, ` +
        'but please file it.'
    : `${overdue.length} grant reports are still outstanding: ${list}. You can still ` +
        'apply, but please file them.';
}

/**
 * Check one organization against one program's policy.
 *
 * Reads only. The caller decides what to do with a `block` -- which is
 * `assertCompliant` below for the paths that must refuse, and a warning
 * attached to the response for the paths that must not.
 */
export async function checkCompliance(
  db: D1Database,
  programId: string,
  organizationId: string,
  opts: { now?: string } = {},
): Promise<ComplianceCheck> {
  const now = opts.now ?? nowIso();

  const program = await db
    .prepare(`SELECT compliance_policy FROM programs WHERE id = ? AND deleted_at IS NULL`)
    .bind(programId)
    .first<{ compliance_policy: string }>();

  // A program that cannot be read is not a licence to block somebody. The
  // permissive default is deliberate: the failure mode of guessing `block` is
  // an eligible nonprofit turned away with no way to argue.
  const policy: CompliancePolicy = isPolicy(program?.compliance_policy)
    ? program.compliance_policy
    : 'ignore';

  if (policy === 'ignore') {
    return { policy, decision: 'allow', overdue: [], message: null };
  }

  // Follow a merge. An organization merged into another carries its history,
  // and checking the wrong side of a merge would let a duplicate row be the
  // way around the gate.
  const target = await resolveMergeTarget(db, organizationId);

  const { results } = await db
    .prepare(
      `SELECT rp.id, rp.label, rp.due_date, rp.status, p.name AS program_name
         FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id AND a.deleted_at IS NULL
         JOIN programs p ON p.id = a.program_id
        WHERE a.organization_id = ?
          AND a.status <> 'cancelled'
          AND rp.deleted_at IS NULL
        ORDER BY rp.due_date`,
    )
    .bind(target)
    .all<{
      id: string;
      label: string;
      due_date: string;
      status: string;
      program_name: string;
    }>();

  const overdue: OverdueReport[] = [];
  for (const r of results ?? []) {
    if (!isOverdue(r.status, r.due_date, now)) continue;
    overdue.push({
      reportPeriodId: r.id,
      label: r.label,
      dueDate: r.due_date,
      daysLate: Math.abs(
        Math.round(
          (Date.parse(`${r.due_date.slice(0, 10)}T00:00:00Z`) -
            Date.parse(`${now.slice(0, 10)}T00:00:00Z`)) /
            86_400_000,
        ),
      ),
      programName: r.program_name,
    });
  }

  const decision: ComplianceDecision =
    overdue.length === 0 ? 'allow' : policy === 'block' ? 'block' : 'warn';

  return { policy, decision, overdue, message: complianceMessage(overdue, decision) };
}

/**
 * Refuse an application when the program's policy says to.
 *
 * Throws CYCLE_CLOSED rather than FORBIDDEN: 403 reads as "you are not allowed
 * here", and this is "there is something to settle first", which is a 409-shaped
 * fact about the request, not about the person.
 */
export async function assertCompliant(
  db: D1Database,
  programId: string,
  organizationId: string,
  opts: { now?: string } = {},
): Promise<ComplianceCheck> {
  const check = await checkCompliance(db, programId, organizationId, opts);
  if (check.decision === 'block') {
    throw new AppError('CONFLICT', check.message ?? 'There is a report still outstanding.', {
      internalMessage:
        `application blocked by compliance policy: organization ${organizationId} has ` +
        `${check.overdue.length} overdue report(s)`,
      severity: 'warn',
      context: {
        program_id: programId,
        overdue_report_period_ids: check.overdue.map((r) => r.reportPeriodId),
      },
    });
  }
  return check;
}
