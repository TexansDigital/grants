/**
 * Recording what the Foundation decided about one application.
 *
 * WHAT THIS IS AND IS NOT. It records a decision. It does not create an award,
 * it does not schedule a payment, and it sends nothing to anybody. CLAUDE.md
 * is unambiguous that decline emails are never sent automatically, and the
 * cheapest way to keep that true is for the function that records a decline to
 * have no way to send anything at all.
 *
 * WHY IT IS ITS OWN MODULE. A decision is the hinge of the whole system: it
 * ends scoring, it starts the retention clock on the applicant's financial
 * documents, and it is what an award is later made against. Putting it beside
 * the scoring code would invite a future caller to decide an application as a
 * side effect of submitting a review.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { nowIso } from './time';
import { auditStatement } from './audit';

/**
 * The outcomes an admin can record.
 *
 * `under_review` is deliberately absent: it is a pipeline state, not a
 * decision, and 0004's CHECK does not require `decided_at` for it. Moving an
 * application into review is not this function's job.
 */
export const DECISION_STATUSES = ['awarded', 'declined', 'withdrawn'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionInput {
  status: DecisionStatus;
  /**
   * Why. Required for a decline, optional otherwise.
   *
   * A decline is the output with the highest reputation risk in this system --
   * 250 of them go out in a week and one gets screenshotted. Whoever writes
   * that email needs to know why, months later, and "no reason recorded" is
   * how a decline letter ends up saying nothing true.
   */
  notes?: string | null;
}

export interface DecisionResult {
  applicationId: string;
  status: DecisionStatus;
  decidedAt: string;
  decidedBy: string;
}

/**
 * Record one decision.
 *
 * ADMIN ONLY. A reviewer scores; they do not decide. The route declares it and
 * this refuses independently, because a function that writes `decided_by` is
 * one somebody will reuse from a less careful handler.
 *
 * REFUSED IF ALREADY DECIDED. Not idempotent-and-silent: a second decision on
 * the same application is either a double-click or somebody overwriting a
 * colleague's call, and both deserve to be told. Changing a settled decision
 * is a deliberate act that does not exist yet and is recorded as a gap.
 */
export async function decideApplication(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  input: DecisionInput,
): Promise<DecisionResult> {
  if (session.role !== 'admin') throw notFound('application');

  if (!DECISION_STATUSES.includes(input.status)) {
    throw new AppError('VALIDATION_FAILED', 'That is not a decision we can record.', {
      internalMessage: `decideApplication with status ${String(input.status)}`,
      severity: 'warn',
    });
  }

  const notes = (input.notes ?? '')?.toString().trim() || null;
  if (input.status === 'declined' && !notes) {
    throw new AppError('VALIDATION_FAILED', 'A decline has to record why.', {
      internalMessage: 'decline with no rationale',
      severity: 'warn',
      fieldErrors: [
        {
          field: 'notes',
          message:
            'Say why this was declined. Whoever writes the letter needs this, and so does ' +
            'anyone asked about it next year.',
        },
      ],
    });
  }

  const app = await db
    .prepare(
      `SELECT id, status, submitted_at AS submittedAt, decided_at AS decidedAt
         FROM applications WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<{ id: string; status: string; submittedAt: string | null; decidedAt: string | null }>();
  if (!app) throw notFound('application');

  if (app.decidedAt) {
    throw new AppError('CONFLICT', 'This application has already been decided.', {
      internalMessage: `decideApplication on ${applicationId}, decided at ${app.decidedAt}`,
      severity: 'warn',
    });
  }
  if (!app.submittedAt) {
    // Deciding a draft would mean recording an outcome for something nobody
    // ever finished sending. It is always a mistaken id.
    throw new AppError('CONFLICT', 'This application has not been submitted.', {
      internalMessage: `decideApplication on unsubmitted ${applicationId}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE applications
            SET status = ?, decided_at = ?, decided_by = ?, decision_notes = ?, updated_at = ?
          WHERE id = ? AND decided_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(input.status, now, session.userId, notes, now, applicationId),
    auditStatement(db, ctx, {
      action: 'application.decided',
      entityType: 'application',
      entityId: applicationId,
      before: { status: app.status, decided_at: null },
      after: {
        status: input.status,
        decided_at: now,
        decided_by: session.userId,
        // The rationale IS recorded here, deliberately. audit_log is internal
        // and append-only; decision_notes on the row can in principle be
        // edited, and the reason a nonprofit was declined should survive that.
        decision_notes: notes,
      },
    }),
  ]);

  return { applicationId, status: input.status, decidedAt: now, decidedBy: session.userId };
}
