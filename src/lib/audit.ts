/**
 * Audit logging.
 *
 * Every write touching an application status, score, decision, award, or
 * payment produces an audit row: actor, timestamp, entity, before, after.
 * Append-only, enforced by triggers in migration 0001.
 *
 * THE IMPORTANT DESIGN POINT:
 *
 * D1 has no interactive transactions. You cannot BEGIN, read, branch, write,
 * and COMMIT over HTTP. The only atomic unit is `db.batch()`, which runs a
 * precomputed list of statements as one transaction.
 *
 * So `auditStatement()` returns a D1PreparedStatement rather than performing a
 * write. The caller puts it in the SAME batch as the mutation it describes.
 * That is what makes "every write produces an audit row" true under failure:
 * either both land or neither does. A helper that wrote the audit row
 * separately would produce silent drift the first time a batch failed halfway.
 *
 * `writeAudit()` exists for the genuinely standalone case (a login, an export)
 * where there is no accompanying mutation.
 */

import type { RequestContext } from '../types';
import { newId } from './ids';
import { nowIso } from './time';
import { redact } from './errors';

/**
 * Stable action verbs. Kept as a union so a typo becomes a type error rather
 * than an audit trail you cannot query.
 */
export type AuditAction =
  // applications
  | 'application.created'
  | 'application.answer_saved'
  | 'application.submitted'
  | 'application.withdrawn'
  | 'application.status_changed'
  | 'application.decided'
  | 'application.internal_note_changed'
  // organizations
  | 'organization.created'
  | 'organization.updated'
  | 'organization.merged'
  | 'contact.created'
  | 'contact.updated'
  | 'organization.ein_verified'
  // forms
  | 'form_definition.created'
  | 'form_definition.published'
  | 'form_definition.retired'
  | 'form_definition.version_created'
  // programs and cycles
  | 'program.created'
  | 'program_stage.created'
  | 'form_section.created'
  | 'form_field.created'
  | 'program.updated'
  | 'cycle.created'
  | 'cycle.updated'
  | 'cycle.opened'
  | 'cycle.closed'
  // rubrics
  | 'rubric.created'
  | 'rubric.published'
  | 'rubric.retired'
  | 'rubric.criterion_changed'
  // reviews
  | 'review.assigned'
  | 'review.unassigned'
  | 'review.conflict_declared'
  | 'review.recused'
  | 'review.score_saved'
  | 'review.completed'
  // awards and payments
  | 'award.created'
  | 'award.amended'
  | 'award.accepted'
  | 'payment.scheduled'
  | 'payment.recorded'
  // reporting
  | 'report_period.created'
  | 'report.submitted'
  | 'report.accepted'
  | 'report.revisions_requested'
  // files and access
  | 'attachment.uploaded'
  | 'attachment.deleted'
  | 'attachment.download_url_issued'
  | 'user.created'
  | 'user.deactivated'
  | 'auth.magic_link_requested'
  | 'auth.logged_in'
  | 'auth.logged_out'
  | 'export.generated';

export type EntityType =
  | 'application'
  | 'application_answer'
  | 'organization'
  | 'contact'
  | 'user'
  | 'program'
  | 'program_stage'
  | 'cycle'
  | 'form_definition'
  | 'review_assignment'
  | 'review_score'
  | 'award'
  | 'payment'
  | 'report_period'
  | 'report_submission'
  | 'attachment'
  | 'export';

export interface AuditInput {
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  /** State before the write. Omit for a create. */
  before?: Record<string, unknown> | null;
  /** State after the write. Omit for a delete. */
  after?: Record<string, unknown> | null;
}

/**
 * Columns that must never be copied into an audit before/after snapshot.
 *
 * The audit trail records that a value changed and who changed it. It is not a
 * second copy of every uploaded financial statement, and it is read by more
 * people than the record itself.
 */
const NEVER_SNAPSHOT = new Set([
  'submission_ip',
  'submission_user_agent',
  'password_hash',
  'token_hash',
]);

/**
 * Applied RECURSIVELY, not just at the top level.
 *
 * A nested submission_ip previously slipped through because filtering happened
 * only on the outermost object. audit_log is append-only with no supported
 * delete path, so anything that lands here lands permanently.
 */
function stripNeverSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripNeverSnapshot(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_SNAPSHOT.has(k)) continue;
    out[k] = stripNeverSnapshot(v, depth + 1);
  }
  return out;
}

function snapshot(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(redact(stripNeverSnapshot(value)));
}

/**
 * Which top-level fields differ between before and after.
 *
 * Precomputed at write time so "what changed on this award" is a column read
 * rather than a JSON diff across thousands of rows at report time.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (NEVER_SNAPSHOT.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      changed.push(k);
    }
  }
  return changed.sort();
}

/**
 * An optional guard makes the audit INSERT conditional on the same predicate as
 * the mutation it accompanies. Without it, a batch whose mutations all no-op
 * (the losing side of a race) still writes an audit row claiming the change
 * happened -- an audit trail that records events that did not occur is worse
 * than none, because it is believed.
 */
export interface AuditGuard {
  sql: string;
  binds: unknown[];
}

function insertSql(guard?: AuditGuard): string {
  return `INSERT INTO audit_log (
   id, actor_user_id, actor_kind, actor_role, actor_organization_id,
   action, entity_type, entity_id,
   before_json, after_json, changed_fields_json,
   request_id, ip, user_agent, created_at
 ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard ? guard.sql : '1=1'}`;
}

/**
 * Build the audit INSERT as a prepared statement, to be placed in the same
 * `db.batch()` as the mutation it describes. This is the normal path.
 */
export function auditStatement(
  db: D1Database,
  ctx: RequestContext,
  input: AuditInput,
  opts: {
    /** Make the audit row conditional on the same predicate as its mutation. */
    guard?: AuditGuard;
    /**
     * Explicit row id and timestamp. Only the seeder supplies these, so a
     * generated seed artifact is byte-stable and therefore reviewable as a
     * diff. Runtime callers omit them and get a random id and the wall clock.
     */
    id?: string;
    now?: string;
  } = {},
): D1PreparedStatement {
  const { guard, id, now } = opts;
  if (input.before == null && input.after == null) {
    // A mutating action must record at least one side. If both are absent, the
    // caller has misused the helper and we would be writing a contentless row.
    throw new Error(`audit ${input.action} must record a before or an after state`);
  }

  const actorKind = ctx.session ? 'user' : 'anonymous';
  return db.prepare(insertSql(guard)).bind(
    id ?? newId(),
    ctx.session?.userId ?? null,
    actorKind,
    ctx.session?.role ?? null,
    ctx.session?.organizationId ?? null,
    input.action,
    input.entityType,
    input.entityId,
    snapshot(input.before),
    snapshot(input.after),
    JSON.stringify(diffFields(input.before, input.after)),
    ctx.requestId,
    ctx.ip ?? null,
    ctx.userAgent ?? null,
    now ?? nowIso(),
    ...(guard?.binds ?? []),
  );
}

/**
 * Write an audit row on its own.
 *
 * Use ONLY where there is no accompanying database mutation to batch with —
 * a login, an export, a download URL being issued. Anywhere a row is being
 * written, use auditStatement() and one batch instead.
 *
 * This throws on failure rather than swallowing. A lost audit row is a
 * correctness failure, not a logging inconvenience.
 */
export async function writeAudit(
  db: D1Database,
  ctx: RequestContext,
  input: AuditInput,
): Promise<void> {
  await auditStatement(db, ctx, input).run();
}
