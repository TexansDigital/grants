/**
 * A grantee telling the Foundation what they did with their grant.
 *
 * The same two-half shape as submit.ts, for the same reason: D1 has no
 * interactive transactions, so everything is read and decided first, and then
 * one db.batch() either lands whole or does nothing.
 *
 * WHERE THIS DIFFERS FROM AN APPLICATION, and why each difference exists:
 *
 *   The draft is a blob. report_drafts holds the raw posted object; nothing is
 *   typed until submit. See 0014 -- a draft is working state, not a record.
 *
 *   Scoping runs through the AWARD. A report period is reachable only via an
 *   award whose organization_id matches the session. An id in a URL can narrow
 *   that query and never widen it, and a miss is a 404.
 *
 *   Submitting writes metric_values. Every field carrying a
 *   metric_definition_id promotes its answer into the aggregation surface in
 *   the SAME batch as the answer, so "how many people did this program serve"
 *   can never disagree with what the grantee actually typed.
 *
 *   A revision is a NEW submission, never an edit. 0012's trigger enforces it;
 *   this code simply never tries.
 *
 * WHAT A GRANTEE NEVER SEES: admin_feedback is the single field on
 * report_submissions that is deliberately visible to them. Nothing else from
 * the staff side -- and no reviewer score, internal note or decision rationale
 * from anywhere else in the system -- is read by this module at all.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound, validationFailed, type FieldError } from './errors';
import { auditStatement } from './audit';
import { validateSubmission, allFields, type FormDefinition } from './forms';
import { loadFormDefinition } from './loadForm';
import { resolveAttachments, MAX_BOUND_PARAMS } from './submit';
import { newId } from './ids';
import { nowIso } from './time';
import { sessionOrgId } from './scope';
import { assertCents } from './money';
import { isStoredEmpty, type StoredValue, type FieldDef } from './fieldTypes';

/** Statuses from which a grantee may still file. */
const FILEABLE_STATUSES = ['scheduled', 'open', 'revisions_requested'] as const;

export interface ReportPeriodForGrantee {
  id: string;
  award_id: string;
  organization_id: string;
  program_id: string;
  form_definition_id: string | null;
  label: string;
  period_type: string;
  period_start: string | null;
  period_end: string | null;
  opens_at: string | null;
  due_date: string;
  status: string;
  awarded_amount_cents: number;
  term_start: string | null;
  term_end: string | null;
}

/**
 * Load a report period the session's organization actually holds.
 *
 * The organization id comes from the SESSION and is applied in SQL. This is the
 * only way a report period is ever loaded for a grantee.
 */
export async function loadGranteePeriod(
  db: D1Database,
  session: Session,
  periodId: string,
): Promise<ReportPeriodForGrantee> {
  const orgId = sessionOrgId(session);
  const row = await db
    .prepare(
      `SELECT rp.id, rp.award_id, a.organization_id, a.program_id, rp.form_definition_id,
              rp.label, rp.period_type, rp.period_start, rp.period_end, rp.opens_at,
              rp.due_date, rp.status, a.awarded_amount_cents, a.term_start, a.term_end
         FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id AND a.deleted_at IS NULL
        WHERE rp.id = ? AND a.organization_id = ? AND rp.deleted_at IS NULL`,
    )
    .bind(periodId, orgId)
    .first<ReportPeriodForGrantee>();

  if (!row) throw notFound('report period');
  return row;
}

/**
 * Can this period be filed against right now?
 *
 * A 'scheduled' period whose opens_at has passed is treated as open. The
 * alternative is an admin flipping sixty rows by hand on the first of the
 * month, which means the one they miss is a grantee who cannot file and
 * believes the deadline is theirs to have missed.
 *
 * A period with NO opens_at is available immediately: a due date with no
 * opening date is an obligation somebody entered by hand, and withholding it
 * would be inventing a rule they did not state.
 */
export function isPeriodFileable(
  period: Pick<ReportPeriodForGrantee, 'status' | 'opens_at'>,
  now: string = nowIso(),
): boolean {
  if (!(FILEABLE_STATUSES as readonly string[]).includes(period.status)) return false;
  if (period.status !== 'scheduled') return true;
  return period.opens_at === null || period.opens_at <= now;
}

function assertFileable(period: ReportPeriodForGrantee, now: string): void {
  if (period.status === 'accepted' || period.status === 'submitted') {
    throw new AppError('CONFLICT', 'This report has already been filed.', {
      internalMessage: `report period ${period.id} is ${period.status}`,
      severity: 'warn',
    });
  }
  if (period.status === 'waived') {
    throw new AppError('CONFLICT', 'This report is no longer required.', {
      internalMessage: `report period ${period.id} is waived`,
      severity: 'warn',
    });
  }
  if (!isPeriodFileable(period, now)) {
    throw new AppError('CONFLICT', 'This report is not open yet.', {
      internalMessage: `report period ${period.id} opens at ${period.opens_at}`,
      severity: 'warn',
    });
  }
  if (!period.form_definition_id) {
    // A real obligation with a date and no form to file it on. Saying so beats
    // a blank page, and it is a configuration problem, not the grantee's.
    throw new AppError('CONFLICT', 'This report form is not ready yet. We will be in touch.', {
      internalMessage: `report period ${period.id} has no form_definition_id`,
      severity: 'error',
    });
  }
}

export interface ReportDraftRow {
  id: string;
  report_period_id: string;
  form_definition_id: string;
  answers_json: string;
  updated_at: string;
}

/** The open draft for a period, if one has been started. */
export async function loadOpenDraft(
  db: D1Database,
  periodId: string,
): Promise<ReportDraftRow | null> {
  return await db
    .prepare(
      `SELECT id, report_period_id, form_definition_id, answers_json, updated_at
         FROM report_drafts
        WHERE report_period_id = ? AND submitted_at IS NULL AND deleted_at IS NULL`,
    )
    .bind(periodId)
    .first<ReportDraftRow>();
}

/** Parse a stored draft blob back into posted-answer shape. */
export function draftAnswers(draft: ReportDraftRow | null): Record<string, unknown> {
  if (!draft) return {};
  try {
    const parsed: unknown = JSON.parse(draft.answers_json);
    // JSON.parse('null') succeeds and returns null, and an array is an object.
    // Both would pass a bare typeof check and then break every read below.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface SaveDraftResult {
  savedAt: string;
  errors: FieldError[];
}

/**
 * Autosave a grantee's in-progress report.
 *
 * Partial validation: type errors are reported (a letter in a dollar box is
 * worth saying immediately) but required-ness is a submit-time concern. The
 * blob is stored as posted either way -- refusing to save a draft because it is
 * incomplete is how somebody loses an hour of work.
 */
export async function saveReportDraft(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  periodId: string,
  raw: Record<string, unknown>,
): Promise<SaveDraftResult> {
  const now = nowIso();
  const period = await loadGranteePeriod(db, session, periodId);
  assertFileable(period, now);

  const definition = await loadFormDefinition(db, period.form_definition_id!);
  const existing = await loadOpenDraft(db, periodId);

  // Merge over what is already saved. The form posts whichever section the
  // grantee touched, and replacing the blob wholesale would delete the rest.
  const merged = { ...draftAnswers(existing), ...raw };

  // Validated for the error list only. The blob that gets stored is `merged`,
  // untyped, because typing a half-answered draft would discard exactly the
  // half-finished values somebody is coming back to.
  const outcome = validateSubmission(definition, merged, { partial: true });

  const payload = JSON.stringify(merged);
  if (payload.length > 400_000) {
    throw new AppError('VALIDATION_FAILED', 'This report is too long to save. Attach a file instead.', {
      internalMessage: `report draft for period ${periodId} is ${payload.length} bytes`,
      severity: 'warn',
    });
  }

  const draftId = existing?.id ?? newId();
  const statements: D1PreparedStatement[] = [];

  /*
   * The period must STILL be fileable when this write lands.
   *
   * assertFileable above read the status a few round-trips ago, and a report
   * being filed from a second device in that window is exactly the case this
   * whole file is shaped around. Guarding only the draft row was not enough,
   * and a staggered race test found why: when the other device wins, the draft
   * it filed is no longer open, so `existing` comes back null, and this took
   * the INSERT path -- opening a brand-new draft against a period that had just
   * been submitted. Nothing was lost, but the grantee's portal then showed
   * unfinished work on a report they had already filed.
   */
  const periodGuard = `(SELECT status FROM report_periods WHERE id = ?) IN (${
    FILEABLE_STATUSES.map(() => '?').join(',')
  })`;
  const periodGuardBinds = [periodId, ...FILEABLE_STATUSES];

  if (existing) {
    statements.push(
      db
        .prepare(
          `UPDATE report_drafts
              SET answers_json = ?, updated_at = ?, updated_by_user_id = ?
            WHERE id = ? AND submitted_at IS NULL AND deleted_at IS NULL
              AND ${periodGuard}`,
        )
        .bind(payload, now, session.userId, draftId, ...periodGuardBinds),
    );
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO report_drafts
             (id, report_period_id, organization_id, form_definition_id, answers_json,
              updated_at, updated_by_user_id, created_at)
           SELECT ?,?,?,?,?,?,?,? WHERE ${periodGuard}`,
        )
        .bind(
          draftId, periodId, period.organization_id, period.form_definition_id,
          payload, now, session.userId, now, ...periodGuardBinds,
        ),
    );
  }

  statements.push(
    auditStatement(db, ctx, {
      action: 'report.draft_saved',
      entityType: 'report_period',
      entityId: periodId,
      // Field KEYS, never values. The audit trail records that a report was
      // being worked on, not a second copy of what it says.
      after: {
        draft_id: draftId,
        saved_field_keys: Object.keys(raw).sort(),
        had_validation_errors: outcome.errors.length > 0,
      },
    // THE SAME GUARD as the write it describes. An audit row asserting a save
    // that did not happen is worse than none, because it is believed.
    }, { guard: { sql: periodGuard, binds: periodGuardBinds } }),
  );

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // The draft was filed by another device between the read and the write.
    throw new AppError('CONFLICT', 'This report has already been filed.', {
      internalMessage: `report draft ${draftId} was filed concurrently`,
      severity: 'warn',
    });
  }

  return { savedAt: now, errors: outcome.errors };
}

/**
 * Which metric_values column an answer of this field type lands in.
 *
 * Mirrors the trigger in 0013 and the scaffolder's FIELD_TYPE_BY_METRIC_TYPE.
 * Returning null for anything else is not a silent skip: the caller treats it
 * as a configuration error, because a field carrying a metric_definition_id
 * that cannot be promoted got past a database trigger that exists to stop it.
 */
export function metricColumnFor(field: FieldDef): 'value_int' | 'value_real' | 'value_text' | null {
  switch (field.field_type) {
    case 'integer':
    case 'currency':
      return 'value_int';
    case 'decimal':
      return 'value_real';
    case 'short_text':
    case 'long_text':
      return 'value_text';
    default:
      return null;
  }
}

/** The value to promote for one metric field, or null when it was left blank. */
export function metricValueFor(
  field: FieldDef,
  stored: StoredValue | undefined,
): { column: 'value_int' | 'value_real' | 'value_text'; value: string | number } | null {
  if (!stored || isStoredEmpty(stored)) return null;
  const column = metricColumnFor(field);
  if (!column) {
    throw new AppError('INTERNAL', 'This report form is misconfigured.', {
      internalMessage: `field ${field.id} (${field.field_type}) carries a metric but cannot promote`,
      severity: 'error',
      context: { field_id: field.id, field_type: field.field_type },
    });
  }
  const value = stored[column];
  if (value === null) return null;

  // The last line of defence before a value reaches a money column: SQLite's
  // TEXT->INTEGER affinity converts the string '2500007' before any CHECK runs.
  if (field.field_type === 'currency' && typeof value === 'number') {
    assertCents(value, field.label);
  }
  return { column, value };
}

export interface SubmitReportResult {
  reportSubmissionId: string;
  submittedAt: string;
  metricsRecorded: number;
  fundsSpentCents: number | null;
}

/**
 * File a report.
 *
 * Read and decide, then one batch. Every statement in the batch carries the
 * same guard -- the period must still be in a fileable status -- and the flip
 * to 'submitted' is last, so a double-submit from two devices lands once.
 */
export async function submitReport(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  periodId: string,
  raw: Record<string, unknown> = {},
): Promise<SubmitReportResult> {
  const now = nowIso();
  const period = await loadGranteePeriod(db, session, periodId);
  assertFileable(period, now);

  const definition = await loadFormDefinition(db, period.form_definition_id!);
  const draft = await loadOpenDraft(db, periodId);
  // Whatever was typed on the final screen wins over what was autosaved.
  const answers = { ...draftAnswers(draft), ...raw };

  // The WHOLE definition, not just the section last touched. A report that
  // passes section by section and fails as a whole is how somebody loses an
  // evening at a deadline.
  const outcome = validateSubmission(definition, answers);
  if (outcome.errors.length > 0) throw validationFailed(outcome.errors);

  const submissionId = newId();
  const fields = allFields(definition);

  const attachments = await resolveAttachments(
    db, period.organization_id, submissionId, definition, outcome.answers,
  );
  if (attachments.errors.length > 0) throw validationFailed(attachments.errors);

  // ---- promotion -----------------------------------------------------------
  const metricFields = fields.filter((f) => f.metric_definition_id);
  const promotedMetrics: {
    metricId: string;
    column: 'value_int' | 'value_real' | 'value_text';
    value: string | number;
  }[] = [];

  for (const field of metricFields) {
    const promoted = metricValueFor(field, outcome.answers.get(field.id));
    if (!promoted) continue;
    promotedMetrics.push({ metricId: field.metric_definition_id!, ...promoted });
  }

  const fundsSpentCents = await resolveFundsSpent(db, period.program_id, promotedMetrics);

  // ---- write ---------------------------------------------------------------
  const guard = `(SELECT status FROM report_periods WHERE id = ?) IN (${
    FILEABLE_STATUSES.map(() => '?').join(',')
  })`;
  const guardBinds = [periodId, ...FILEABLE_STATUSES];

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO report_submissions
           (id, report_period_id, submitted_by_user_id, submitted_at, funds_spent_cents,
            submission_ip, submission_user_agent, created_at, updated_at)
         SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`,
      )
      .bind(
        submissionId, periodId, session.userId, now, fundsSpentCents,
        ctx.ip, ctx.userAgent, now, now, ...guardBinds,
      ),
  ];

  for (const field of fields) {
    const stored = outcome.answers.get(field.id);
    if (!stored || isStoredEmpty(stored)) continue;
    if (field.field_type === 'currency' && stored.value_int !== null) {
      assertCents(stored.value_int, field.label);
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO report_answers
             (id, report_submission_id, form_field_id, value_text, value_int, value_real,
              value_json, answered_at)
           SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
        )
        .bind(
          newId(), submissionId, field.id, stored.value_text, stored.value_int,
          stored.value_real, stored.value_json, now, ...guardBinds,
        ),
    );
  }

  for (const m of promotedMetrics) {
    const cols = { value_int: null, value_real: null, value_text: null } as Record<string, unknown>;
    cols[m.column] = m.value;
    statements.push(
      db
        .prepare(
          `INSERT INTO metric_values
             (id, report_submission_id, metric_definition_id, value_int, value_real,
              value_text, created_at)
           SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
        )
        .bind(
          newId(), submissionId, m.metricId, cols.value_int, cols.value_real,
          cols.value_text, now, ...guardBinds,
        ),
    );
  }

  for (let i = 0; i < attachments.ids.length; i += MAX_BOUND_PARAMS) {
    const chunk = attachments.ids.slice(i, i + MAX_BOUND_PARAMS);
    statements.push(
      db
        .prepare(
          `UPDATE attachments
              SET parent_type = 'report_submission', parent_id = ?
            WHERE id IN (${chunk.map(() => '?').join(',')}) AND ${guard}`,
        )
        .bind(submissionId, ...chunk, ...guardBinds),
    );
  }

  if (draft) {
    statements.push(
      db
        .prepare(
          `UPDATE report_drafts
              SET submitted_at = ?, report_submission_id = ?
            WHERE id = ? AND submitted_at IS NULL AND ${guard}`,
        )
        .bind(now, submissionId, draft.id, ...guardBinds),
    );
  }

  statements.push(
    auditStatement(db, ctx, {
      action: 'report.submitted',
      entityType: 'report_submission',
      entityId: submissionId,
      after: {
        report_period_id: periodId,
        award_id: period.award_id,
        organization_id: period.organization_id,
        funds_spent_cents: fundsSpentCents,
        metrics_recorded: promotedMetrics.length,
        attachments: attachments.ids.length,
      },
    }, { guard: { sql: guard, binds: guardBinds } }),
    // LAST. Its row count is the authoritative answer about whether this call
    // did anything: on the losing side of a concurrent submit every guard above
    // is already false and the whole batch no-ops.
    db
      .prepare(
        `UPDATE report_periods SET status = 'submitted', updated_at = ?
          WHERE id = ? AND status IN (${FILEABLE_STATUSES.map(() => '?').join(',')})
            AND deleted_at IS NULL`,
      )
      .bind(now, periodId, ...FILEABLE_STATUSES),
  );

  const results = await db.batch(statements);
  const flipped = results[results.length - 1]?.meta.changes ?? 0;
  if (flipped === 0) {
    throw new AppError('CONFLICT', 'This report has already been filed.', {
      internalMessage: `report period ${periodId} was filed concurrently`,
      severity: 'warn',
    });
  }

  return {
    reportSubmissionId: submissionId,
    submittedAt: now,
    metricsRecorded: promotedMetrics.length,
    fundsSpentCents,
  };
}

/**
 * The funds-spent figure, from whichever metric this program named.
 *
 * Null when the program names none, which is a legitimate configuration: not
 * every funder asks a grantee to account for spend on the report.
 */
async function resolveFundsSpent(
  db: D1Database,
  programId: string,
  promoted: readonly { metricId: string; column: string; value: string | number }[],
): Promise<number | null> {
  if (promoted.length === 0) return null;
  const claimant = await db
    .prepare(
      `SELECT id FROM metric_definitions
        WHERE program_id = ? AND promotes_to = 'funds_spent_cents' AND deleted_at IS NULL`,
    )
    .bind(programId)
    .first<{ id: string }>();
  if (!claimant) return null;

  const match = promoted.find((p) => p.metricId === claimant.id);
  if (!match) return null;
  if (match.column !== 'value_int' || typeof match.value !== 'number') {
    // The schema permits only a currency metric to claim this, and only a
    // currency field to report it. Reaching here means both guards were
    // bypassed, and guessing at the value would be the money bug they exist to
    // prevent.
    throw new AppError('INTERNAL', 'This report form is misconfigured.', {
      internalMessage: `funds_spent metric ${claimant.id} promoted into ${match.column}`,
      severity: 'error',
    });
  }
  assertCents(match.value, 'Funds spent');
  return match.value;
}
