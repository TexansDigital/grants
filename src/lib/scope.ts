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
 * The SQL scope a staff session has over `applications`, as a JOIN and binds.
 *
 * ONE definition, used by the detail view, the review queue, the pipeline list
 * and full-text search. That is the whole point of it existing: those four had
 * begun to drift, and search had drifted furthest -- it gated on "is this
 * person staff" and nothing else, so a reviewer received snippets of the
 * narrative of every application in the system, including ones nobody had
 * assigned to them. A snippet of another organization's narrative is seeing it.
 *
 * The caller aliases `applications` as `a`. Admins get an empty join and see
 * everything; reviewers get the three conditions that define their access.
 * Anyone else gets a join that cannot match, so a new staff-ish role added
 * later fails closed rather than inheriting admin's reach.
 */
export interface StaffScope {
  /** Extra JOIN clauses, placed immediately after `FROM applications a`. */
  join: string;
  /**
   * Extra predicate. Callers must place it FIRST in their WHERE clause, before
   * any predicate of their own, so the bind order is always
   * join-binds, where-binds, then the caller's. `where` carries no binds today;
   * putting it first means adding one later cannot silently misalign a caller.
   */
  where: string;
  /** Binds for `join` then `where`, in that order. */
  binds: unknown[];
}

export function staffApplicationScope(session: Session): StaffScope {
  if (session.role === 'admin') return { join: '', where: '1 = 1', binds: [] };
  if (session.role === 'reviewer') {
    return {
      join: `JOIN review_assignments ra
               ON ra.application_id = a.id
              AND ra.reviewer_user_id = ?
              AND ra.recused_at IS NULL
              AND ra.deleted_at IS NULL`,
      where: '1 = 1',
      binds: [session.userId],
    };
  }
  // Executives have no in-app access by design; applicants and grantees do not
  // use the staff path at all. A predicate that cannot match, rather than a
  // thrown error, so a list endpoint returns an honest empty set instead of an
  // oracle -- and so a staff-ish role added later fails closed by default.
  return { join: '', where: '1 = 0', binds: [] };
}

/**
 * Fetch one application for STAFF.
 *
 * Admins see everything. A reviewer sees only applications assigned to them —
 * enforced here in SQL via review_assignments rather than in the caller, so
 * there is no path that forgets.
 *
 * Three conditions gate a reviewer, and all three are in the JOIN rather than
 * in a caller's `if`:
 *   - the assignment names them,
 *   - it has not been recused,
 *   - it has not been soft-deleted.
 * The last one was missing while the table did not exist, so unassigning a
 * reviewer the way the rest of this schema unassigns anything — a soft delete —
 * would have left their access intact.
 */
export async function getApplicationForStaff(
  db: D1Database,
  session: Session,
  applicationId: string,
): Promise<Record<string, unknown>> {
  const scope = staffApplicationScope(session);
  const row = await db
    .prepare(
      `SELECT a.* FROM applications a
       ${scope.join}
        WHERE ${scope.where} AND a.id = ? AND a.deleted_at IS NULL`,
    )
    .bind(...scope.binds, applicationId)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('application');
  return row;
}

/**
 * The review queue: every application assigned to this reviewer.
 *
 * Lives here, beside getApplicationForStaff, rather than in a route. The list
 * and the detail view must agree exactly about what a reviewer may see — if
 * they drift, the queue shows a row that 404s when clicked, or worse, the queue
 * leaks a title the detail view would have refused. Same three conditions, same
 * file, one place to get it wrong.
 *
 * An admin passed to this gets their OWN assignments, not everything. An admin
 * wanting the whole pipeline asks for the pipeline.
 */
export async function listApplicationsForReviewer(
  db: D1Database,
  session: Session,
): Promise<Record<string, unknown>[]> {
  if (session.role !== 'reviewer' && session.role !== 'admin') {
    // Applicants, grantees and executives have no review queue. Empty, not an
    // error: this is a list endpoint, and "nothing assigned to you" is a
    // legitimate answer that reveals nothing.
    return [];
  }
  // Always the reviewer scope, even for an admin: this endpoint answers "what
  // is assigned to ME", and an admin asking for the whole pipeline asks for the
  // pipeline.
  const { results } = await db
    .prepare(
      `SELECT a.id, a.cycle_id, a.stage_id, a.organization_id, a.status,
              a.project_title, a.requested_amount_cents, a.submitted_at,
              ra.id AS review_assignment_id, ra.assigned_at, ra.completed_at,
              ra.conflict_declared_at
         FROM applications a
         JOIN review_assignments ra
           ON ra.application_id = a.id
          AND ra.reviewer_user_id = ?
          AND ra.recused_at IS NULL
          AND ra.deleted_at IS NULL
        WHERE a.deleted_at IS NULL
        ORDER BY ra.assigned_at DESC`,
    )
    .bind(session.userId)
    .all<Record<string, unknown>>();
  return results ?? [];
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

// -----------------------------------------------------------------------------
// The staff read surface
// -----------------------------------------------------------------------------

export interface PipelineFilters {
  programId?: string | null;
  cycleId?: string | null;
  stageId?: string | null;
  status?: string | null;
  organizationId?: string | null;
  /** Inclusive bounds, integer cents. */
  minAmountCents?: number | null;
  maxAmountCents?: number | null;
  limit?: number;
  offset?: number;
}

/**
 * Columns a REVIEWER may see on an application.
 *
 * An allowlist, like the applicant one, and for the same reason: a migration
 * that adds an internal column must not start leaking it the day it ships.
 *
 * `internal_notes` and `decision_notes` are deliberately absent. CLAUDE.md
 * forbids them in applicant and grantee payloads and is silent about
 * reviewers, so this is a judgement call made conservatively: staff commentary
 * and prior decision rationale reaching a reviewer before they score is a
 * route to anchoring their score on someone else's opinion, which is precisely
 * what a rubric exists to prevent. Flip it deliberately if the programme wants
 * reviewers to see them -- do not let it happen by adding a column.
 */
const REVIEWER_APPLICATION_COLUMNS = [
  'id',
  'cycle_id',
  'stage_id',
  'organization_id',
  'form_definition_id',
  'status',
  'project_title',
  'requested_amount_cents',
  'guidelines_version',
  'submitted_at',
  'created_at',
  'updated_at',
] as const;

/** Admins see the row as it is. Reviewers see the allowlist above. */
function applicationColumnsFor(session: Session): string {
  if (session.role === 'admin') return 'a.*';
  return REVIEWER_APPLICATION_COLUMNS.map((c) => `a.${c}`).join(', ');
}

/**
 * The pipeline: applications this staff session may see, filtered.
 *
 * Filters are all optional and all bound, never interpolated. `status` and the
 * ids arrive from a query string and are treated as untrusted; the only thing
 * interpolated into this SQL is the scope from staffApplicationScope and a
 * column list built from a constant.
 */
export async function listApplicationsForStaff(
  db: D1Database,
  session: Session,
  filters: PipelineFilters = {},
): Promise<{ applications: Record<string, unknown>[]; total: number }> {
  const scope = staffApplicationScope(session);

  const where: string[] = [scope.where, 'a.deleted_at IS NULL'];
  const binds: unknown[] = [...scope.binds];

  const eq = (column: string, value: string | null | undefined) => {
    if (!value) return;
    where.push(`${column} = ?`);
    binds.push(value);
  };
  eq('c.program_id', filters.programId);
  eq('a.cycle_id', filters.cycleId);
  eq('a.stage_id', filters.stageId);
  eq('a.status', filters.status);
  eq('a.organization_id', filters.organizationId);

  // Money bounds are integer cents. A caller that sends dollars gets wildly
  // wrong results rather than an error, so the route parses them as integers
  // and rejects anything else before reaching here.
  if (typeof filters.minAmountCents === 'number') {
    where.push('a.requested_amount_cents >= ?');
    binds.push(filters.minAmountCents);
  }
  if (typeof filters.maxAmountCents === 'number') {
    where.push('a.requested_amount_cents <= ?');
    binds.push(filters.maxAmountCents);
  }

  const from = `FROM applications a
                JOIN cycles c ON c.id = a.cycle_id
                LEFT JOIN organizations o ON o.id = a.organization_id
                ${scope.join}`;
  const whereSql = where.join(' AND ');

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT ${applicationColumnsFor(session)},
              o.legal_name AS organization_name,
              o.ein AS organization_ein,
              c.name AS cycle_name,
              c.program_id AS program_id
       ${from}
        WHERE ${whereSql}
        ORDER BY a.submitted_at DESC, a.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<Record<string, unknown>>();

  return { applications: results ?? [], total: countRow?.n ?? 0 };
}

/**
 * One application with everything a staff member needs to read it: the
 * organization, the answers keyed by field, and the attachment metadata.
 *
 * Answers come back keyed by `field_key` rather than as a row list, because the
 * caller already has the form definition and needs to render label-and-answer
 * in the definition's order. Sending both orderings would invite the UI to
 * pick the wrong one.
 */
export async function getApplicationDetailForStaff(
  db: D1Database,
  session: Session,
  applicationId: string,
): Promise<Record<string, unknown>> {
  // Authorization happens here, in the same function that failed closed before.
  const application = await getApplicationForStaff(db, session, applicationId);

  // Reviewers get the allowlist even on the detail view. getApplicationForStaff
  // returns the whole row because it is also the authorization gate; the
  // projection is applied here, once, on the way out.
  const projected =
    session.role === 'admin'
      ? application
      : Object.fromEntries(
          REVIEWER_APPLICATION_COLUMNS.filter((c) => c in application).map((c) => [c, application[c]]),
        );

  const organization = await db
    .prepare(
      `SELECT id, legal_name, dba_name, ein, ein_verified_at, ein_verified_name,
              website, address_json, mission, annual_operating_budget_cents, status
         FROM organizations WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(application.organization_id)
    .first<Record<string, unknown>>();

  const { results: answerRows } = await db
    .prepare(
      `SELECT f.field_key, ans.value_text, ans.value_int, ans.value_real,
              ans.value_json, ans.answered_at
         FROM application_answers ans
         JOIN form_fields f ON f.id = ans.form_field_id
        WHERE ans.application_id = ?`,
    )
    .bind(applicationId)
    .all<Record<string, unknown>>();

  const answers: Record<string, unknown> = {};
  for (const row of answerRows ?? []) {
    const { field_key: key, ...value } = row;
    answers[String(key)] = value;
  }

  const { results: attachments } = await db
    .prepare(
      `SELECT id, filename, mime_type, size_bytes, uploaded_at
         FROM attachments
        WHERE parent_type = 'application' AND parent_id = ? AND deleted_at IS NULL
        ORDER BY uploaded_at`,
    )
    .bind(applicationId)
    .all<Record<string, unknown>>();

  return {
    application: projected,
    organization: organization ?? null,
    answers,
    // Metadata only. The object key is never sent; a download goes through a
    // separate endpoint that issues a short-lived signed URL and audits it.
    attachments: attachments ?? [],
  };
}

/**
 * Applicant history, for the panel a reviewer sees when they open an
 * application.
 *
 * CLAUDE.md is specific about why this exists: "this org has applied three
 * times, was funded once for $25,000, filed both reports on time" is
 * institutional memory that currently lives in one person's head. It is scoped
 * the same way everything else is -- a reviewer sees the history of an
 * organization only through applications assigned to them.
 */
export async function organizationHistoryForStaff(
  db: D1Database,
  session: Session,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const scope = staffApplicationScope(session);

  // A reviewer with no assignment to this organization gets nothing, not an
  // empty history that confirms the organization exists.
  const visible = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM applications a ${scope.join}
        WHERE ${scope.where} AND a.organization_id = ? AND a.deleted_at IS NULL`,
    )
    .bind(...scope.binds, organizationId)
    .first<{ n: number }>();
  if ((visible?.n ?? 0) === 0) throw notFound('organization');

  const organization = await db
    .prepare(
      `SELECT id, legal_name, ein, ein_verified_at, website, mission,
              annual_operating_budget_cents, status
         FROM organizations WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(organizationId)
    .first<Record<string, unknown>>();
  if (!organization) throw notFound('organization');

  // The history itself is the ORGANIZATION's, not the reviewer's slice of it.
  // A reviewer who is assigned one of this organization's applications is
  // entitled to know it has applied four times before -- that is the point of
  // the panel. What they do not get is the narrative of those other
  // applications, so this returns counts, statuses and dates only.
  const { results: applications } = await db
    .prepare(
      `SELECT a.id, a.status, a.submitted_at, a.requested_amount_cents,
              a.project_title, c.name AS cycle_name, c.program_id
         FROM applications a
         JOIN cycles c ON c.id = a.cycle_id
        WHERE a.organization_id = ? AND a.deleted_at IS NULL
        ORDER BY a.submitted_at DESC, a.created_at DESC`,
    )
    .bind(organizationId)
    .all<Record<string, unknown>>();

  const rows = applications ?? [];
  return {
    organization,
    applications: rows,
    summary: {
      total_applications: rows.length,
      // Awards do not exist until migration 0007, so "funded" is deliberately
      // absent rather than guessed at from a status name.
      by_status: rows.reduce<Record<string, number>>((acc, r) => {
        const key = String(r.status);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}
