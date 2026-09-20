/**
 * Putting away an organization or an application that should not be there.
 *
 * WHY THIS EXISTS. Registration is open — anybody may complete the eligibility
 * screen and become an organization — and the Foundation clears out the fakes
 * afterwards. That is a workable way to run intake. It is not workable without
 * a way to clear anything out, and until now nothing in the system could soft-
 * delete an organization or an application at all.
 *
 * SOFT, ALWAYS. `deleted_at` and a reason and an audit row. Non-negotiable #7
 * has no exception for rows that turned out to be rubbish, and the cost of
 * being wrong here is deleting a real nonprofit's application on a busy
 * afternoon.
 *
 * THE GUARD THAT MATTERS MORE THAN THE FEATURE. An organization holding an
 * award, or one that has submitted an application, is refused outright. Those
 * are not junk by definition: somebody either gave them money or read their
 * work. The junk this is for has a name, maybe an EIN, and nothing else. If an
 * admin genuinely needs to remove a funded organization, that is a merge or a
 * conversation, not a button.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement } from './audit';
import { nowIso } from './time';

/** Short enough to be read in a list, long enough to say what happened. */
const MAX_REASON = 500;
const MIN_REASON = 3;

function cleanReason(reason: string): string {
  const text = reason.trim();
  if (text.length < MIN_REASON) {
    throw new AppError('VALIDATION_FAILED', 'Please say why this is being removed.', {
      internalMessage: 'soft-delete attempted with an empty or near-empty reason',
      severity: 'warn',
    });
  }
  return text.slice(0, MAX_REASON);
}

export interface JunkBlocker {
  /** What stopped it, in words an admin can act on. */
  message: string;
  awards: number;
  submittedApplications: number;
}

/**
 * Why this organization cannot be put away, or null if it can.
 *
 * Exported so a screen can grey the control out and say why, rather than
 * offering a button that answers 409.
 */
export async function organizationJunkBlocker(
  db: D1Database,
  organizationId: string,
): Promise<JunkBlocker | null> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM awards
           WHERE organization_id = ? AND deleted_at IS NULL) AS awards,
         (SELECT COUNT(*) FROM applications
           WHERE organization_id = ? AND submitted_at IS NOT NULL AND deleted_at IS NULL)
           AS submitted`,
    )
    .bind(organizationId, organizationId)
    .first<{ awards: number; submitted: number }>();

  const awards = Number(row?.awards ?? 0);
  const submitted = Number(row?.submitted ?? 0);
  if (awards === 0 && submitted === 0) return null;

  const parts: string[] = [];
  if (awards > 0) parts.push(`${awards} award${awards === 1 ? '' : 's'}`);
  if (submitted > 0) {
    parts.push(`${submitted} submitted application${submitted === 1 ? '' : 's'}`);
  }
  return {
    message:
      `This organization has ${parts.join(' and ')}. ` +
      'Something with a grant or a submitted application is not junk — merge it if it is a ' +
      'duplicate, or leave it.',
    awards,
    submittedApplications: submitted,
  };
}

/**
 * Put an organization away, with everything of its own that is still a draft.
 *
 * CASCADES TO DRAFTS AND SIGN-INS, because leaving them live would leave a
 * removed organization able to log in and keep typing. Draft applications
 * only — a submitted one is caught by the guard above, so if execution reaches
 * here there are none.
 *
 * Does NOT touch contacts or attachments. They hang off rows that are now
 * marked deleted and are reachable only through them, and unpicking them makes
 * a restore materially harder to get right.
 */
export async function junkOrganization(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  organizationId: string,
  reason: string,
): Promise<{ applications: number; users: number }> {
  const text = cleanReason(reason);

  const before = await db
    .prepare(
      `SELECT id, legal_name, ein, status FROM organizations
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(organizationId)
    .first<Record<string, unknown>>();
  if (!before) throw notFound('organization');

  const blocker = await organizationJunkBlocker(db, organizationId);
  if (blocker) {
    throw new AppError('CONFLICT', blocker.message, {
      internalMessage:
        `junk refused for organization ${organizationId}: ` +
        `${blocker.awards} awards, ${blocker.submittedApplications} submitted`,
      severity: 'warn',
      context: { awards: blocker.awards, submitted: blocker.submittedApplications },
    });
  }

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM applications
           WHERE organization_id = ? AND deleted_at IS NULL) AS applications,
         (SELECT COUNT(*) FROM users
           WHERE organization_id = ? AND deleted_at IS NULL) AS users`,
    )
    .bind(organizationId, organizationId)
    .first<{ applications: number; users: number }>();

  const now = nowIso();
  /*
   * CHILDREN FIRST, PARENT LAST.
   *
   * 0002 carries a trigger refusing to soft-delete an organization that still
   * has live applications or users -- which is the schema being right and this
   * function having the order backwards. Deleting the parent first tripped it
   * every time, with an error naming the trigger rather than the ordering.
   *
   * D1 runs a batch in order, so the applications and sign-ins go away before
   * the organization does and the trigger sees what it expects.
   */
  await db.batch([
    db
      .prepare(
        `UPDATE applications SET deleted_at = ?, deleted_reason = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, `Organization removed: ${text}`, now, organizationId),
    /*
     * SOFT-DELETED AND DEACTIVATED, both.
     *
     * Deactivating alone was the first attempt, on the reasoning that the row
     * is how a magic link resolves and an inactive user is refused at sign-in
     * anyway. The trigger above disagrees, and it is right: it counts users by
     * `deleted_at IS NULL`, so a merely-deactivated sign-in still blocks the
     * organization and leaves exactly the orphan the rule exists to prevent.
     *
     * is_active is set as well as deleted_at, so a restore that somehow missed
     * one of them still cannot produce a usable sign-in.
     */
    db
      .prepare(
        `UPDATE users SET is_active = 0, deleted_at = ?, updated_at = ?
          WHERE organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, now, organizationId),
    db
      .prepare(
        `UPDATE organizations SET deleted_at = ?, deleted_reason = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(now, text, now, organizationId),
    auditStatement(
      db,
      ctx,
      {
        action: 'organization.removed',
        entityType: 'organization',
        entityId: organizationId,
        before,
        after: { ...before, deleted_at: now, deleted_reason: text },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM organizations WHERE id = ? AND deleted_at = ?)`,
          binds: [organizationId, now],
        },
      },
    ),
  ]);

  return {
    applications: Number(counts?.applications ?? 0),
    users: Number(counts?.users ?? 0),
  };
}

/**
 * Undo it.
 *
 * ONLY WHAT THIS REMOVAL TOOK. Rows are restored by matching the exact
 * `deleted_at` stamp written above, so restoring an organization removed in
 * March does not also revive an application somebody deleted separately in
 * January. Restoring by organization id alone would do precisely that, and the
 * mistake would look like a success.
 */
export async function restoreOrganization(
  db: D1Database,
  ctx: RequestContext,
  _session: Session,
  organizationId: string,
): Promise<void> {
  const before = await db
    .prepare(
      `SELECT id, legal_name, deleted_at, deleted_reason FROM organizations
        WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .bind(organizationId)
    .first<Record<string, unknown>>();
  if (!before) throw notFound('organization');

  const stamp = String(before.deleted_at);
  const now = nowIso();

  await db.batch([
    db
      .prepare(
        `UPDATE organizations SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
          WHERE id = ? AND deleted_at = ?`,
      )
      .bind(now, organizationId, stamp),
    db
      .prepare(
        `UPDATE applications SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
          WHERE organization_id = ? AND deleted_at = ?`,
      )
      .bind(now, organizationId, stamp),
    // Only the sign-ins this removal took, matched on its stamp -- same rule as
    // the applications above, and for the same reason.
    db
      .prepare(
        `UPDATE users SET is_active = 1, deleted_at = NULL, updated_at = ?
          WHERE organization_id = ? AND deleted_at = ?`,
      )
      .bind(now, organizationId, stamp),
    auditStatement(
      db,
      ctx,
      {
        action: 'organization.restored',
        entityType: 'organization',
        entityId: organizationId,
        before,
        after: { ...before, deleted_at: null, deleted_reason: null },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM organizations WHERE id = ? AND deleted_at IS NULL)`,
          binds: [organizationId],
        },
      },
    ),
  ]);
}

/**
 * Put away a single application without touching its organization.
 *
 * For the case where the organization is real and one submission is not — a
 * duplicate, a test, an application to the wrong program.
 *
 * REFUSES A DECIDED APPLICATION. Once a decision is recorded, the application
 * is the evidence for it, and removing it leaves an award or a decline with
 * nothing behind it.
 */
export async function junkApplication(
  db: D1Database,
  ctx: RequestContext,
  _session: Session,
  applicationId: string,
  reason: string,
): Promise<void> {
  const text = cleanReason(reason);

  const before = await db
    .prepare(
      `SELECT id, organization_id, status, submitted_at, decided_at FROM applications
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<Record<string, unknown>>();
  if (!before) throw notFound('application');

  if (before.decided_at !== null) {
    throw new AppError('CONFLICT', 'A decided application cannot be removed.', {
      internalMessage: `junk refused: application ${applicationId} was decided`,
      severity: 'warn',
    });
  }

  const awarded = await db
    .prepare(`SELECT COUNT(*) AS n FROM awards WHERE application_id = ? AND deleted_at IS NULL`)
    .bind(applicationId)
    .first<{ n: number }>();
  if (Number(awarded?.n ?? 0) > 0) {
    throw new AppError('CONFLICT', 'That application has an award against it.', {
      internalMessage: `junk refused: application ${applicationId} has ${awarded?.n} awards`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE applications SET deleted_at = ?, deleted_reason = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(now, text, now, applicationId),
    auditStatement(
      db,
      ctx,
      {
        action: 'application.removed',
        entityType: 'application',
        entityId: applicationId,
        before,
        after: { ...before, deleted_at: now, deleted_reason: text },
      },
      {
        guard: {
          sql: `EXISTS (SELECT 1 FROM applications WHERE id = ? AND deleted_at = ?)`,
          binds: [applicationId, now],
        },
      },
    ),
  ]);
}

export interface RemovedRow {
  id: string;
  legal_name: string;
  ein: string | null;
  deleted_at: string;
  deleted_reason: string | null;
  applications: number;
}

/**
 * What has been put away, most recent first.
 *
 * EXISTS SO A MISTAKE IS FINDABLE. A soft delete nobody can see is a hard
 * delete with extra steps: the row is gone from every screen, and the only
 * route back is somebody writing SQL against a production database, which is
 * the thing this project does not do.
 */
export async function listRemovedOrganizations(
  db: D1Database,
  limit = 100,
): Promise<RemovedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.legal_name, o.ein, o.deleted_at, o.deleted_reason,
              (SELECT COUNT(*) FROM applications a
                WHERE a.organization_id = o.id AND a.deleted_at = o.deleted_at) AS applications
         FROM organizations o
        WHERE o.deleted_at IS NOT NULL
        ORDER BY o.deleted_at DESC
        LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<RemovedRow>();
  return results ?? [];
}
