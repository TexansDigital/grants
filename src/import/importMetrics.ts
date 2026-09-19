/**
 * Writing a program's impact metrics into the database.
 *
 * Two phases, as with awards: `planMetricImport` reads and decides,
 * `applyMetricImport` writes what was planned. A dry run is the plan with the
 * second call not made.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE AWARDS IMPORT. An awards file is history:
 * it is imported once and re-running it is a no-op. A metrics file is
 * CONFIGURATION, and the second run is the normal case -- somebody rewords a
 * question, adds a metric, retires one. So this is an upsert keyed on
 * metric_key, and the interesting decisions are about what a second run may and
 * may not change.
 *
 * THE ONE THING A RE-IMPORT MAY NEVER DO IS CHANGE A METRIC'S TYPE. Values
 * already reported against it were collected as counts, or dollars, or text,
 * and reinterpreting them restates history. The database refuses it once values
 * exist; this refuses it always, because by the time values exist the form has
 * already been built around the old type and the failure would surface as a
 * constraint violation nobody can read. An admin who genuinely means it retires
 * the metric and adds one under a new key, which keeps both series intact.
 *
 * NOTHING IS DELETED. A metric missing from the file is REPORTED, not removed,
 * and retiring it is a separate deliberate act -- every value ever reported
 * against a metric hangs off its row, and deleting one would silently rewrite
 * last year's totals.
 */

import type { RequestContext } from '../types';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/time';
import { auditStatement } from '../lib/audit';
import type { ParsedMetric } from './metrics';

interface ExistingMetric {
  id: string;
  metric_key: string;
  label: string;
  help_text: string | null;
  metric_type: string;
  unit: string | null;
  is_required: number;
  sort_order: number;
  status: string;
  promotes_to: string | null;
}

export type MetricPlan =
  | { kind: 'create'; metric: ParsedMetric; metricId: string }
  /** Present in both, with something to change. `changes` names the fields. */
  | { kind: 'update'; metric: ParsedMetric; metricId: string; changes: string[] }
  /** Present in both and identical. A second run of an unchanged file. */
  | { kind: 'unchanged'; metric: ParsedMetric; metricId: string }
  /** In the database, absent from the file. Reported, never removed. */
  | { kind: 'missing'; existing: ExistingMetric }
  /** Needs a human before anything is written. */
  | { kind: 'blocked'; metric: ParsedMetric; reason: string };

export interface MetricImportPlan {
  rows: MetricPlan[];
  ok: boolean;
  summary: {
    toCreate: number;
    toUpdate: number;
    unchanged: number;
    missingFromFile: number;
    blocked: number;
  };
}

/** What a re-import would change about one existing metric. */
function diff(existing: ExistingMetric, incoming: ParsedMetric): string[] {
  const changes: string[] = [];
  if (existing.label !== incoming.label) changes.push('label');
  if ((existing.help_text ?? null) !== incoming.helpText) changes.push('help_text');
  if ((existing.unit ?? null) !== incoming.unit) changes.push('unit');
  if ((existing.is_required === 1) !== incoming.isRequired) changes.push('is_required');
  if (existing.sort_order !== incoming.sortOrder) changes.push('sort_order');
  if ((existing.promotes_to ?? null) !== incoming.promotesTo) changes.push('promotes_to');
  // A metric back in a file after being retired is being un-retired.
  if (existing.status !== 'active') changes.push('status');
  return changes;
}

/** Decide what would happen, writing nothing. */
export async function planMetricImport(
  db: D1Database,
  programId: string,
  metrics: readonly ParsedMetric[],
): Promise<MetricImportPlan> {
  const program = await db
    .prepare(`SELECT id FROM programs WHERE id = ? AND deleted_at IS NULL`)
    .bind(programId)
    .first<{ id: string }>();
  if (!program) {
    throw new AppError('NOT_FOUND', 'That program could not be found.', {
      internalMessage: `metric import for unknown program ${programId}`,
      severity: 'warn',
    });
  }

  const { results } = await db
    .prepare(
      `SELECT id, metric_key, label, help_text, metric_type, unit, is_required,
              sort_order, status, promotes_to
         FROM metric_definitions
        WHERE program_id = ? AND deleted_at IS NULL`,
    )
    .bind(programId)
    .all<ExistingMetric>();
  const existingByKey = new Map((results ?? []).map((r) => [r.metric_key, r]));

  const rows: MetricPlan[] = [];
  const seen = new Set<string>();

  for (const metric of metrics) {
    seen.add(metric.metricKey);
    const existing = existingByKey.get(metric.metricKey);

    if (!existing) {
      rows.push({ kind: 'create', metric, metricId: newId() });
      continue;
    }

    if (existing.metric_type !== metric.metricType) {
      rows.push({
        kind: 'blocked',
        metric,
        reason:
          `"${metric.metricKey}" is already a ${existing.metric_type} metric and this file ` +
          `makes it ${metric.metricType}. Values already reported against it were collected ` +
          'as the old type. Retire it and add a new metric under a different key instead.',
      });
      continue;
    }

    const changes = diff(existing, metric);
    rows.push(
      changes.length === 0
        ? { kind: 'unchanged', metric, metricId: existing.id }
        : { kind: 'update', metric, metricId: existing.id, changes },
    );
  }

  for (const existing of existingByKey.values()) {
    if (!seen.has(existing.metric_key) && existing.status === 'active') {
      rows.push({ kind: 'missing', existing });
    }
  }

  const count = (k: MetricPlan['kind']) => rows.filter((r) => r.kind === k).length;
  const blocked = count('blocked');

  return {
    rows,
    ok: blocked === 0,
    summary: {
      toCreate: count('create'),
      toUpdate: count('update'),
      unchanged: count('unchanged'),
      missingFromFile: count('missing'),
      blocked,
    },
  };
}

export interface MetricImportResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Metrics in the program that this file did not mention. Untouched. */
  missingFromFile: string[];
}

/**
 * Write a plan.
 *
 * One batch: a metrics file is a few dozen rows at most, well inside D1's
 * limits, and a half-applied configuration change is a form scaffolded from
 * half a spreadsheet.
 */
export async function applyMetricImport(
  db: D1Database,
  ctx: RequestContext,
  programId: string,
  plan: MetricImportPlan,
): Promise<MetricImportResult> {
  if (!plan.ok) {
    throw new AppError('VALIDATION_FAILED', 'This metrics file cannot be imported yet.', {
      internalMessage: `metric import for ${programId} has ${plan.summary.blocked} blocked row(s)`,
      severity: 'warn',
      context: {
        blocked: plan.rows.filter((r) => r.kind === 'blocked').map((r) => r.reason),
      },
    });
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  /*
   * Clear every promotes_to claim first.
   *
   * The unique index permits one claimant per program, so moving the claim from
   * metric A to metric B in one file fails if B is written while A still holds
   * it. Clearing first makes the order of the rows in the spreadsheet stop
   * mattering, which it should not have mattered in the first place.
   */
  if (plan.rows.some((r) => (r.kind === 'create' || r.kind === 'update') && r.metric.promotesTo)) {
    statements.push(
      db
        .prepare(
          `UPDATE metric_definitions SET promotes_to = NULL, updated_at = ?
            WHERE program_id = ? AND promotes_to IS NOT NULL AND deleted_at IS NULL`,
        )
        .bind(now, programId),
    );
  }

  for (const row of plan.rows) {
    if (row.kind === 'create') {
      const m = row.metric;
      statements.push(
        db
          .prepare(
            `INSERT INTO metric_definitions
               (id, program_id, metric_key, label, help_text, metric_type, unit,
                is_required, sort_order, status, promotes_to, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
          )
          .bind(
            row.metricId, programId, m.metricKey, m.label, m.helpText, m.metricType,
            m.unit, m.isRequired ? 1 : 0, m.sortOrder, m.promotesTo, now, now,
          ),
        auditStatement(db, ctx, {
          action: 'metric_definition.created',
          entityType: 'metric_definition',
          entityId: row.metricId,
          after: {
            program_id: programId, metric_key: m.metricKey, metric_type: m.metricType,
            is_required: m.isRequired, promotes_to: m.promotesTo,
          },
        }),
      );
      continue;
    }

    if (row.kind === 'update') {
      const m = row.metric;
      statements.push(
        db
          .prepare(
            `UPDATE metric_definitions
                SET label = ?, help_text = ?, unit = ?, is_required = ?, sort_order = ?,
                    promotes_to = ?, status = 'active', updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(
            m.label, m.helpText, m.unit, m.isRequired ? 1 : 0, m.sortOrder,
            m.promotesTo, now, row.metricId,
          ),
        auditStatement(db, ctx, {
          action: 'metric_definition.updated',
          entityType: 'metric_definition',
          entityId: row.metricId,
          // The fields that changed, not their values: the metric row itself is
          // the record, and this says what to go and look at.
          before: { changed: row.changes },
          after: {
            metric_key: m.metricKey, is_required: m.isRequired,
            sort_order: m.sortOrder, promotes_to: m.promotesTo,
          },
        }),
      );
    }
  }

  if (statements.length > 0) await db.batch(statements);

  return {
    created: plan.summary.toCreate,
    updated: plan.summary.toUpdate,
    unchanged: plan.summary.unchanged,
    missingFromFile: plan.rows
      .filter((r): r is Extract<MetricPlan, { kind: 'missing' }> => r.kind === 'missing')
      .map((r) => r.existing.metric_key),
  };
}

/**
 * Retire metrics, as a separate deliberate act.
 *
 * Never part of an import. A metric missing from a spreadsheet is far more
 * often a column somebody forgot to paste than a decision to stop asking, and
 * the cost of guessing wrong is a question silently dropped from next year's
 * report form.
 */
export async function retireMetrics(
  db: D1Database,
  ctx: RequestContext,
  programId: string,
  metricKeys: readonly string[],
): Promise<number> {
  if (metricKeys.length === 0) return 0;
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  for (const key of metricKeys) {
    const row = await db
      .prepare(
        `SELECT id FROM metric_definitions
          WHERE program_id = ? AND metric_key = ? AND status = 'active' AND deleted_at IS NULL`,
      )
      .bind(programId, key)
      .first<{ id: string }>();
    if (!row) continue;

    statements.push(
      db
        .prepare(
          // Retired, never deleted: every value ever reported against this
          // metric hangs off the row, and removing it rewrites past totals.
          `UPDATE metric_definitions SET status = 'retired', updated_at = ? WHERE id = ?`,
        )
        .bind(now, row.id),
      auditStatement(db, ctx, {
        action: 'metric_definition.retired',
        entityType: 'metric_definition',
        entityId: row.id,
        before: { status: 'active' },
        after: { status: 'retired', metric_key: key },
      }),
    );
  }

  if (statements.length === 0) return 0;
  await db.batch(statements);
  return statements.length / 2;
}
