/**
 * Organization scoping and response projection.
 *
 * This is the file that must not be wrong. Two rules live here:
 *
 *   1. Every query touching external-user data is scoped by organization_id
 *      DERIVED FROM THE SESSION, never from a request parameter. Changing an id
 *      in a URL returns 404, not 403 — a 403 would confirm the row exists.
 *
 *   2. Reviewer scores, internal notes, and decision rationale are never
 *      returned by an applicant or grantee endpoint. Not hidden in the UI:
 *      ABSENT FROM THE PAYLOAD. That is why external reads go through an
 *      explicit column allowlist below rather than `SELECT *` plus deletion of
 *      a few keys — a future migration that adds an internal column would
 *      otherwise start leaking it the day it ships.
 */

import type { Session } from '../types';
import { AppError, notFound } from './errors';

export function isExternalRole(session: Session): boolean {
  return session.role === 'applicant' || session.role === 'grantee';
}

export function isStaffRole(session: Session): boolean {
  return session.role === 'admin' || session.role === 'reviewer';
}

/**
 * The organization id to scope this session's queries by.
 *
 * Throws for a session that has no organization. There is deliberately no
 * parameter here: there is no way to ask this function for a different
 * organization than the one on the session.
 */
export function sessionOrgId(session: Session): string {
  if (!isExternalRole(session)) {
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `sessionOrgId called for internal role ${session.role}`,
      severity: 'error',
    });
  }
  if (!session.organizationId) {
    // The database CHECK constraint on users makes this unreachable via normal
    // login. If it ever fires, an external session was constructed by hand.
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `external session ${session.userId} has no organization_id`,
      severity: 'fatal',
    });
  }
  return session.organizationId;
}

/**
 * Assert that a row belongs to the session's organization.
 *
 * Deliberately throws NOT_FOUND, never FORBIDDEN. Use after a fetch that could
 * not be scoped in SQL; prefer scoping in the query itself.
 */
export function assertOwnedByExternalSession(
  session: Session,
  rowOrganizationId: string | null | undefined,
  entity = 'record',
): void {
  if (!isExternalRole(session)) {
    // Previously this returned, which silently authorized admin, reviewer AND
    // executive for any endpoint whose only check was this helper -- and
    // executives are documented as having no in-app access at all. The name
    // read like a universal ownership assertion; the behaviour was "no-op for
    // anyone who is not an applicant". Now the caller must pick a staff path
    // explicitly.
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `assertOwnedByExternalSession called for internal role ${session.role}`,
      severity: 'error',
    });
  }
  const orgId = sessionOrgId(session);
  if (!rowOrganizationId || rowOrganizationId !== orgId) {
    throw notFound(entity);
  }
}

// -----------------------------------------------------------------------------
// Projections
// -----------------------------------------------------------------------------

/**
 * Columns of `applications` an applicant or grantee may ever see.
 *
 * An allowlist, not a denylist. Adding a column to the table does not add it
 * here, which is the point.
 */
export const APPLICANT_APPLICATION_COLUMNS = [
  'id',
  'cycle_id',
  'stage_id',
  'organization_id',
  'form_definition_id',
  'prior_application_id',
  'submitted_by_contact_id',
  'status',
  'guidelines_version',
  'submitted_at',
  'project_title',
  'requested_amount_cents',
  'organization_name_at_submit',
  'ein_at_submit',
  'primary_contact_email',
  'counties_served_json',
  'created_at',
  'updated_at',
] as const;

/**
 * Columns that must NEVER appear in an external payload, from any table.
 * Used by both the projection builder and a test that guards it.
 */
export const INTERNAL_ONLY_COLUMNS = [
  'internal_notes',
  'decision_notes',
  'decided_by',
  'decided_at',
  'submission_ip',
  'submission_user_agent',
  'score',
  'comment',
  'reviewer_user_id',
  'conflict_note',
  'admin_feedback',
] as const;

const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * Build a `SELECT a, b, c` list from an allowlist.
 *
 * This is the only place in the codebase that interpolates into SQL. Today its
 * inputs are compile-time constants, but a `?fields=` query parameter is one
 * feature away, so the identifier shape is validated here rather than trusted
 * to a comment.
 */
export function selectList(columns: readonly string[], alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return columns
    .map((c) => {
      if (!SAFE_COLUMN.test(c)) {
        throw new AppError('INTERNAL', 'Something went wrong on our end.', {
          internalMessage: `unsafe column identifier in selectList: ${c}`,
          severity: 'fatal',
        });
      }
      return `${prefix}${c}`;
    })
    .join(', ');
}

/**
 * Fetch one application for an EXTERNAL user.
 *
 * Scoping is in the WHERE clause, using the session's organization id. The
 * applicationId is untrusted input and is only ever an equality match; it can
 * never widen the scope.
 */
export async function getApplicationForExternal(
  db: D1Database,
  session: Session,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const orgId = sessionOrgId(session);
  const row = await db
    .prepare(
      `SELECT ${selectList(APPLICANT_APPLICATION_COLUMNS)}
         FROM applications
        WHERE id = ?
          AND organization_id = ?
          AND deleted_at IS NULL`,
    )
    .bind(applicationId, orgId)
    .first<Record<string, unknown>>();

  if (!row) throw notFound('application');
  return row;
}

/** List an external user's own applications. Scope comes from the session. */
export async function listApplicationsForExternal(
  db: D1Database,
  session: Session,
): Promise<Record<string, unknown>[]> {
  const orgId = sessionOrgId(session);
  const { results } = await db
    .prepare(
      `SELECT ${selectList(APPLICANT_APPLICATION_COLUMNS)}
         FROM applications
        WHERE organization_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC`,
    )
    .bind(orgId)
    .all<Record<string, unknown>>();
  return results ?? [];
}

/**
 * Fetch one application for STAFF.
 *
 * Admins see everything. A reviewer sees only applications assigned to them —
 * enforced here in SQL via review_assignments rather than in the caller, so
 * there is no path that forgets. The assignment table arrives in Phase 3; until
 * then a reviewer's scope resolves to nothing, which is the safe direction to
 * be wrong in.
 */
export async function getApplicationForStaff(
  db: D1Database,
  session: Session,
  applicationId: string,
  opts: { reviewAssignmentsExist?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (session.role === 'admin') {
    const row = await db
      .prepare(`SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL`)
      .bind(applicationId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound('application');
    return row;
  }

  if (session.role === 'reviewer') {
    if (!opts.reviewAssignmentsExist) {
      // Phase 0/1: no assignment table yet. Fail closed.
      throw notFound('application');
    }
    const row = await db
      .prepare(
        `SELECT a.*
           FROM applications a
           JOIN review_assignments ra
             ON ra.application_id = a.id
            AND ra.reviewer_user_id = ?
            AND ra.recused_at IS NULL
          WHERE a.id = ?
            AND a.deleted_at IS NULL`,
      )
      .bind(session.userId, applicationId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound('application');
    return row;
  }

  // executive: no in-app access at all, by design. They receive exports.
  throw notFound('application');
}

/**
 * Defence-in-depth check used by tests and by the response serializer:
 * assert that an outbound external payload carries no internal-only key.
 */
export function assertNoInternalFields(payload: unknown, path = 'payload'): void {
  // Assert against what will ACTUALLY be sent. Walking the live object let an
  // object with a toJSON() that returns internal fields pass the check while
  // JSON.stringify emitted them, and let a non-enumerable property through.
  if (path === 'payload') {
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(payload ?? null));
    } catch {
      throw new AppError('INTERNAL', 'Something went wrong on our end.', {
        internalMessage: 'external payload could not be serialized for inspection',
        severity: 'fatal',
      });
    }
    return assertNoInternalFields(serialized, 'payload.serialized');
  }
  if (payload === null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoInternalFields(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((INTERNAL_ONLY_COLUMNS as readonly string[]).includes(key)) {
      throw new AppError('INTERNAL', 'Something went wrong on our end.', {
        internalMessage: `internal-only field "${key}" present in external ${path}`,
        severity: 'fatal',
        context: { path, key },
      });
    }
    assertNoInternalFields(value, `${path}.${key}`);
  }
}
