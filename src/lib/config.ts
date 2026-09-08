/**
 * Program configuration writes: programs, stages, cycles.
 *
 * The first mutating code in the system, so it sets the pattern the rest will
 * follow. Three rules, applied without exception:
 *
 *   1. Every mutation and its audit row go out in ONE `db.batch()`. D1 has no
 *      interactive transactions; batch is the only atomic unit available. A
 *      write that succeeds while its audit row fails is a financial record with
 *      no provenance, and CLAUDE.md's non-negotiable #6 does not have an
 *      "unless the second statement failed" clause.
 *   2. Nothing is hard-deleted. `deleted_at` is set, and every read filters it.
 *   3. The `before` snapshot is read first and passed to the audit row, so the
 *      trail records what actually changed rather than only the new value.
 *
 * Input is validated here rather than at the route, because the route's job is
 * routing. A field that reaches the database unvalidated is a CHECK constraint
 * away from a 500 that reads like an outage.
 */

import type { Env, RequestContext } from '../types';
import { auditStatement, type AuditAction, type AuditGuard, type EntityType } from './audit';
import { AppError, notFound, validationFailed } from './errors';
import type { FieldError } from './fieldTypes';
import { newId } from './ids';
import { nowIso } from './time';

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read and parse a JSON body.
 *
 * Bounded before parsing. An unbounded JSON.parse on a request body is a way to
 * spend a Worker's whole CPU budget on one request.
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'That request was too large.', {
      internalMessage: `body ${raw.length} bytes exceeds ${MAX_BODY_BYTES}`,
      severity: 'warn',
    });
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validationFailed([{ field: '_body', message: 'The request body was not valid JSON.' }]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw validationFailed([{ field: '_body', message: 'The request body must be an object.' }]);
  }
  return parsed as Record<string, unknown>;
}

/** Collects field errors so a caller sees every problem at once, not the first. */
class Fields {
  private readonly errors: FieldError[] = [];
  constructor(private readonly body: Record<string, unknown>) {}

  private has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body, key);
  }

  text(key: string, opts: { required?: boolean; max?: number; label?: string } = {}): string | undefined {
    const label = opts.label ?? key;
    if (!this.has(key)) {
      if (opts.required) this.errors.push({ field: key, message: `${label} is required.` });
      return undefined;
    }
    const raw = this.body[key];
    if (raw === null) return undefined;
    if (typeof raw !== 'string') {
      this.errors.push({ field: key, message: `${label} must be text.` });
      return undefined;
    }
    const value = raw.trim();
    if (value === '') {
      if (opts.required) this.errors.push({ field: key, message: `${label} is required.` });
      return undefined;
    }
    if (opts.max !== undefined && value.length > opts.max) {
      this.errors.push({ field: key, message: `${label} must be ${opts.max} characters or fewer.` });
      return undefined;
    }
    return value;
  }

  /** One of a fixed set. Rejects anything else rather than letting a CHECK do it. */
  enum<T extends string>(key: string, allowed: readonly T[], opts: { required?: boolean } = {}): T | undefined {
    const value = this.text(key, { required: opts.required });
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      this.errors.push({ field: key, message: `${key} must be one of: ${allowed.join(', ')}.` });
      return undefined;
    }
    return value as T;
  }

  integer(key: string, opts: { required?: boolean; min?: number; max?: number } = {}): number | undefined {
    if (!this.has(key)) {
      if (opts.required) this.errors.push({ field: key, message: `${key} is required.` });
      return undefined;
    }
    const raw = this.body[key];
    if (raw === null) return undefined;
    // A JSON float is rejected outright rather than rounded. Silent rounding is
    // how a budget becomes wrong by a cent and nobody can say when.
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      this.errors.push({ field: key, message: `${key} must be a whole number.` });
      return undefined;
    }
    if (opts.min !== undefined && raw < opts.min) {
      this.errors.push({ field: key, message: `${key} must be at least ${opts.min}.` });
      return undefined;
    }
    if (opts.max !== undefined && raw > opts.max) {
      this.errors.push({ field: key, message: `${key} must be no more than ${opts.max}.` });
      return undefined;
    }
    return raw;
  }

  /** An ISO-8601 instant. Storage is UTC; anything else is normalised here. */
  instant(key: string, opts: { required?: boolean } = {}): string | undefined {
    const value = this.text(key, { required: opts.required });
    if (value === undefined) return undefined;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      this.errors.push({ field: key, message: `${key} must be a date and time, for example 2026-03-02T05:59:00Z.` });
      return undefined;
    }
    return new Date(ms).toISOString();
  }

  boolean(key: string): boolean | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.body[key];
    if (typeof raw !== 'boolean') {
      this.errors.push({ field: key, message: `${key} must be true or false.` });
      return undefined;
    }
    return raw;
  }

  /** Throws every collected problem at once. */
  done(): void {
    if (this.errors.length > 0) throw validationFailed(this.errors);
  }
}

// ---------------------------------------------------------------------------
// Shared write machinery
// ---------------------------------------------------------------------------

/**
 * A slug an admin did not have to think about, derived from the name.
 *
 * Not reversible and not meaningful — it only has to be stable, URL-safe, and
 * unique per program, which the partial unique index enforces.
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base === '' ? `p-${newId().slice(0, 8)}` : base;
}

async function loadLive(
  db: D1Database,
  table: 'programs' | 'program_stages' | 'cycles',
  id: string,
): Promise<Record<string, unknown>> {
  // Table name is from a closed union above, never from a request.
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound(table === 'programs' ? 'program' : table === 'cycles' ? 'cycle' : 'stage');
  return row;
}

/**
 * Run a mutation and its audit row as one atomic batch, then confirm the
 * mutation actually changed a row.
 *
 * Two things here are load-bearing, and the first version of this function got
 * both wrong -- a concurrent double-open produced one state change and TWO
 * audit rows, one of which claimed an event that never happened.
 *
 * ORDER. The audit statement goes FIRST. D1 runs a batch sequentially inside
 * one transaction, so a statement placed after the mutation sees the mutated
 * state. An audit row guarded on the pre-state ("status is still draft") would
 * then be suppressed for the winner as well as the loser. Audit first, and the
 * guard sees what the mutation is about to change.
 *
 * CONFIRMATION. D1 reports success for an UPDATE that matched nothing, so the
 * mutation's own `meta.changes` is what says whether anything happened. It is
 * results[1] precisely because the audit row went first.
 *
 * The alternative -- mutation first, audit guarded on the POST-state -- was
 * rejected: two writers in the same millisecond compute the same `updated_at`,
 * and the loser's guard then matches the winner's row. That is the same
 * same-millisecond collision that already bit the submit path once.
 */
async function commit(
  db: D1Database,
  mutation: D1PreparedStatement,
  auditRow: D1PreparedStatement,
): Promise<void> {
  const results = await db.batch([auditRow, mutation]);
  const applied = results[1];
  if (!applied || applied.meta.changes < 1) {
    throw new AppError('CONFLICT', 'That record changed while you were editing it. Reload and try again.', {
      internalMessage: 'mutation matched no rows; the guard or the id did not hold',
      severity: 'warn',
    });
  }
}

/** A row is live and unchanged since we read it. */
function liveGuard(table: 'programs' | 'cycles', id: string): AuditGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL)`,
    binds: [id],
  };
}

interface Actor {
  db: D1Database;
  ctx: RequestContext;
}

/**
 * The audit row for a mutation.
 *
 * `guard` is REQUIRED, with no default. It must be the same predicate the
 * mutation's WHERE clause uses, so that a mutation which no-ops cannot leave
 * behind a row asserting it happened. An INSERT passes `null` explicitly --
 * an insert either lands or takes the whole batch down with it, so there is
 * nothing to guard against; making that an explicit `null` rather than an
 * omitted argument means nobody forgets a guard by accident.
 */
function audit(
  db: D1Database,
  ctx: RequestContext,
  action: AuditAction,
  entityType: EntityType,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  guard: AuditGuard | null,
): D1PreparedStatement {
  return auditStatement(
    db,
    ctx,
    { action, entityType, entityId, before, after },
    guard ? { guard } : {},
  );
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const PROGRAM_STATUS = ['draft', 'active', 'archived'] as const;
const COMPLIANCE_POLICY = ['block', 'warn', 'ignore'] as const;

export async function createProgram(
  { db, ctx }: Actor,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const f = new Fields(body);
  const name = f.text('name', { required: true, max: 200, label: 'Program name' });
  const description = f.text('description', { max: 4000 });
  const status = f.enum('status', PROGRAM_STATUS) ?? 'draft';
  const compliancePolicy = f.enum('compliance_policy', COMPLIANCE_POLICY) ?? 'warn';
  const fiscalYear = f.integer('fiscal_year', { min: 2000, max: 2200 });
  const totalBudgetCents = f.integer('total_budget_cents', { min: 0 });
  const maxPerCycle = f.integer('max_applications_per_cycle', { min: 1 });
  f.done();

  const id = newId();
  const now = nowIso();
  const after = {
    id,
    name: name!,
    slug: slugify(name!),
    description: description ?? null,
    status,
    fiscal_year: fiscalYear ?? null,
    total_budget_cents: totalBudgetCents ?? null,
    compliance_policy: compliancePolicy,
    max_applications_per_cycle: maxPerCycle ?? null,
    created_at: now,
    updated_at: now,
  };

  await commit(
    db,
    db
      .prepare(
        `INSERT INTO programs (id, name, slug, description, status, fiscal_year,
                               total_budget_cents, compliance_policy,
                               max_applications_per_cycle, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        after.id, after.name, after.slug, after.description, after.status,
        after.fiscal_year, after.total_budget_cents, after.compliance_policy,
        after.max_applications_per_cycle, now, now,
      ),
    audit(db, ctx, 'program.created', 'program', id, null, after, null),
  );

  return after;
}

export async function updateProgram(
  { db, ctx }: Actor,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const before = await loadLive(db, 'programs', id);
  const f = new Fields(body);
  const name = f.text('name', { max: 200, label: 'Program name' });
  const description = f.text('description', { max: 4000 });
  const status = f.enum('status', PROGRAM_STATUS);
  const compliancePolicy = f.enum('compliance_policy', COMPLIANCE_POLICY);
  const fiscalYear = f.integer('fiscal_year', { min: 2000, max: 2200 });
  const totalBudgetCents = f.integer('total_budget_cents', { min: 0 });
  const maxPerCycle = f.integer('max_applications_per_cycle', { min: 1 });
  f.done();

  const now = nowIso();
  const after = {
    ...before,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(compliancePolicy !== undefined ? { compliance_policy: compliancePolicy } : {}),
    ...(fiscalYear !== undefined ? { fiscal_year: fiscalYear } : {}),
    ...(totalBudgetCents !== undefined ? { total_budget_cents: totalBudgetCents } : {}),
    ...(maxPerCycle !== undefined ? { max_applications_per_cycle: maxPerCycle } : {}),
    updated_at: now,
  };

  await commit(
    db,
    db
      .prepare(
        `UPDATE programs
            SET name = ?, description = ?, status = ?, fiscal_year = ?,
                total_budget_cents = ?, compliance_policy = ?,
                max_applications_per_cycle = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(
        after.name, after.description, after.status, after.fiscal_year,
        after.total_budget_cents, after.compliance_policy,
        after.max_applications_per_cycle, now, id,
      ),
    audit(db, ctx, 'program.updated', 'program', id, before, after, liveGuard('programs', id)),
  );

  return after;
}

/**
 * Soft-delete a program.
 *
 * Refused while live cycles hang off it. Archiving a program out from under an
 * open cycle would leave applications pointing at a parent the UI no longer
 * lists, which is how a record becomes unreachable without being deleted.
 */
export async function deleteProgram({ db, ctx }: Actor, id: string): Promise<void> {
  const before = await loadLive(db, 'programs', id);
  const live = await db
    .prepare(`SELECT COUNT(*) AS n FROM cycles WHERE program_id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ n: number }>();
  if ((live?.n ?? 0) > 0) {
    throw new AppError('CONFLICT', 'Remove this program’s cycles before archiving it.', {
      internalMessage: `program ${id} still has ${live?.n} live cycles`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await commit(
    db,
    db.prepare(`UPDATE programs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(now, now, id),
    audit(db, ctx, 'program.updated', 'program', id, before, { ...before, deleted_at: now },
      liveGuard('programs', id)),
  );
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export async function createStage(
  { db, ctx }: Actor,
  programId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await loadLive(db, 'programs', programId);
  const f = new Fields(body);
  const name = f.text('name', { required: true, max: 200, label: 'Stage name' });
  const stageKey = f.text('stage_key', { max: 80 });
  const sortOrder = f.integer('sort_order', { min: 0 }) ?? 0;
  const gate = f.boolean('gate_on_prior_decision') ?? false;
  f.done();

  const id = newId();
  const now = nowIso();
  const after = {
    id,
    program_id: programId,
    stage_key: stageKey ?? slugify(name!),
    name: name!,
    sort_order: sortOrder,
    gate_on_prior_decision: gate ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  await commit(
    db,
    db
      .prepare(
        `INSERT INTO program_stages (id, program_id, stage_key, name, sort_order,
                                     gate_on_prior_decision, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        after.id, after.program_id, after.stage_key, after.name,
        after.sort_order, after.gate_on_prior_decision, now, now,
      ),
    audit(db, ctx, 'program_stage.created', 'program_stage', id, null, after, null),
  );

  return after;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

const CYCLE_STATUS = ['draft', 'open', 'closed', 'decided', 'archived'] as const;

export async function createCycle(
  { db, ctx }: Actor,
  programId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await loadLive(db, 'programs', programId);
  const f = new Fields(body);
  const name = f.text('name', { required: true, max: 200, label: 'Cycle name' });
  const opensAt = f.instant('opens_at', { required: true });
  const closesAt = f.instant('closes_at', { required: true });
  const decisionDueAt = f.instant('decision_due_at');
  const announcementDate = f.instant('announcement_date');
  // Open decision #6, made explicit per cycle. 0 is a hard cutoff.
  const graceHours = f.integer('draft_grace_hours', { min: 0, max: 720 }) ?? 0;
  f.done();

  // Checked here as well as by the CHECK constraint, so an admin gets a
  // sentence instead of a constraint violation surfacing as a 500.
  if (opensAt && closesAt && closesAt <= opensAt) {
    throw validationFailed([
      { field: 'closes_at', message: 'The cycle must close after it opens.' },
    ]);
  }

  const id = newId();
  const now = nowIso();
  const after = {
    id,
    program_id: programId,
    name: name!,
    opens_at: opensAt!,
    closes_at: closesAt!,
    decision_due_at: decisionDueAt ?? null,
    announcement_date: announcementDate ?? null,
    // A cycle is always born closed to applicants. Opening it is a separate,
    // audited action -- creating a cycle and opening it in one call is how a
    // form goes live before anyone meant it to.
    status: 'draft' as const,
    rubric_id: null,
    draft_grace_hours: graceHours,
    created_at: now,
    updated_at: now,
  };

  await commit(
    db,
    db
      .prepare(
        `INSERT INTO cycles (id, program_id, name, opens_at, closes_at, decision_due_at,
                             announcement_date, status, draft_grace_hours, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        after.id, after.program_id, after.name, after.opens_at, after.closes_at,
        after.decision_due_at, after.announcement_date, after.status,
        after.draft_grace_hours, now, now,
      ),
    audit(db, ctx, 'cycle.created', 'cycle', id, null, after, null),
  );

  return after;
}

export async function updateCycle(
  { db, ctx }: Actor,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const before = await loadLive(db, 'cycles', id);
  const f = new Fields(body);
  const name = f.text('name', { max: 200, label: 'Cycle name' });
  const opensAt = f.instant('opens_at');
  const closesAt = f.instant('closes_at');
  const decisionDueAt = f.instant('decision_due_at');
  const announcementDate = f.instant('announcement_date');
  const graceHours = f.integer('draft_grace_hours', { min: 0, max: 720 });
  const rubricId = f.text('rubric_id', { max: 64 });
  f.done();

  // Status is deliberately NOT settable here. open and close are their own
  // audited verbs; a status buried in a general update is a cycle that opens
  // as a side effect of someone fixing a typo in its name.
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    throw validationFailed([
      { field: 'status', message: 'Use the open or close action to change a cycle’s status.' },
    ]);
  }

  const now = nowIso();
  const after = {
    ...before,
    ...(name !== undefined ? { name } : {}),
    ...(opensAt !== undefined ? { opens_at: opensAt } : {}),
    ...(closesAt !== undefined ? { closes_at: closesAt } : {}),
    ...(decisionDueAt !== undefined ? { decision_due_at: decisionDueAt } : {}),
    ...(announcementDate !== undefined ? { announcement_date: announcementDate } : {}),
    ...(graceHours !== undefined ? { draft_grace_hours: graceHours } : {}),
    ...(rubricId !== undefined ? { rubric_id: rubricId } : {}),
    updated_at: now,
  };

  if (String(after.closes_at) <= String(after.opens_at)) {
    throw validationFailed([
      { field: 'closes_at', message: 'The cycle must close after it opens.' },
    ]);
  }

  await commit(
    db,
    db
      .prepare(
        `UPDATE cycles
            SET name = ?, opens_at = ?, closes_at = ?, decision_due_at = ?,
                announcement_date = ?, draft_grace_hours = ?, rubric_id = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(
        after.name, after.opens_at, after.closes_at, after.decision_due_at,
        after.announcement_date, after.draft_grace_hours, after.rubric_id, now, id,
      ),
    audit(db, ctx, 'cycle.updated', 'cycle', id, before, after, liveGuard('cycles', id)),
  );

  return after;
}

/**
 * Open or close a cycle.
 *
 * Its own verb, with its own audit action, because this is the write that
 * decides whether the public form accepts submissions. "Who opened the cycle,
 * and when" must be a row anyone can find, not a field that changed inside a
 * general update.
 *
 * The status transition is guarded IN THE UPDATE, not read-then-written: two
 * admins pressing Open at the same moment must produce one state change and one
 * audit row, and `WHERE status = ?` is what makes the second one a no-op that
 * `commit` then reports as a conflict.
 */
export async function setCycleStatus(
  { db, ctx }: Actor,
  id: string,
  next: 'open' | 'closed',
): Promise<Record<string, unknown>> {
  const before = await loadLive(db, 'cycles', id);
  const current = String(before.status);

  const allowedFrom: Record<string, readonly string[]> = {
    open: ['draft', 'closed'],
    closed: ['open'],
  };
  if (!allowedFrom[next]!.includes(current)) {
    throw new AppError('CONFLICT', `A ${current} cycle cannot be ${next === 'open' ? 'opened' : 'closed'}.`, {
      internalMessage: `cycle ${id} transition ${current} -> ${next} is not allowed`,
      severity: 'warn',
      context: { from: current, to: next },
    });
  }

  const now = nowIso();
  const after = { ...before, status: next, updated_at: now };

  await commit(
    db,
    db
      .prepare(`UPDATE cycles SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND deleted_at IS NULL`)
      .bind(next, now, id, current),
    // The SAME predicate as the UPDATE. The loser of a double-open finds the
    // status already flipped, its guard is false, and no row is written
    // claiming an event that did not happen.
    audit(db, ctx, next === 'open' ? 'cycle.opened' : 'cycle.closed', 'cycle', id, before, after, {
      sql: `EXISTS (SELECT 1 FROM cycles WHERE id = ? AND status = ? AND deleted_at IS NULL)`,
      binds: [id, current],
    }),
  );

  return after;
}
