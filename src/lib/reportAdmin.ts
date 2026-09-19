/**
 * The staff half of grantee reporting.
 *
 * Without this, `accepted` and `revisions_requested` are states nothing can
 * reach: a grantee files into a queue nobody reads. Four things live here --
 * the portfolio view, reading one filed report, and the two decisions staff
 * make about it.
 *
 * WHAT IS NOT HERE, and why. Reminders are Eloqua's job (CLAUDE.md: bulk,
 * scheduled, latency does not matter), and the compliance policy's effect on a
 * NEW application belongs beside the eligibility screen that enforces it. This
 * file is the review desk, nothing else.
 *
 * EVERY DECISION IS APPEND-ONLY IN EFFECT. Accepting stamps the submission and
 * closes the period, and 0012's trigger makes acceptance terminal. Asking for
 * changes writes feedback and reopens the period -- and the grantee's answer to
 * it is a NEW submission, never an edit of the one being discussed.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement } from './audit';
import { nowIso } from './time';
import { loadFormDefinition } from './loadForm';
import { allFields } from './forms';
import { displayValue } from './answerDisplay';
import { isStaffRole } from './scope';
import { daysUntil as daysUntilDue, isOverdue as reportIsOverdue } from './reportDue';
import type { StoredValue } from './fieldTypes';

function assertStaff(session: Session): void {
  if (!isStaffRole(session)) {
    throw new AppError('FORBIDDEN', 'That action is not available.', {
      internalMessage: `report admin reached by role ${session.role}`,
      severity: 'error',
    });
  }
}

function assertAdmin(session: Session): void {
  if (session.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only an administrator can do that.', {
      internalMessage: `report decision attempted by role ${session.role}`,
      severity: 'warn',
    });
  }
}

export interface PortfolioRow {
  reportPeriodId: string;
  awardId: string;
  organizationId: string;
  organizationName: string;
  programName: string;
  label: string;
  periodType: string;
  dueDate: string;
  status: string;
  awardedAmountCents: number;
  submittedAt: string | null;
  fundsSpentCents: number | null;
  /** Negative when the due date has passed and nothing has been filed. */
  daysUntilDue: number;
  overdue: boolean;
}

export interface PortfolioFilters {
  programId?: string | null;
  status?: string | null;
  organizationId?: string | null;
  /** Only what is late. */
  overdueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/*
 * daysUntil and isOverdue now live in reportDue.ts.
 *
 * They moved because the application gate asks the same question, and a
 * definition of "overdue" that forked between the compliance desk and the gate
 * would mean refusing a nonprofit a grant cycle over a report the desk shows as
 * fine. Re-exported so existing callers and their tests are unaffected.
 */
export { daysUntil, isOverdue } from './reportDue';

/**
 * The portfolio compliance view.
 *
 * One query. An admin looking at "what is outstanding across every grant" is
 * looking at a few hundred rows a year, and a per-award round-trip would be a
 * dozen queries to render one screen.
 */
export async function reportPortfolio(
  db: D1Database,
  session: Session,
  filters: PortfolioFilters = {},
): Promise<{ rows: PortfolioRow[]; total: number }> {
  assertStaff(session);

  const where: string[] = ['rp.deleted_at IS NULL', 'a.deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (filters.programId) {
    where.push('a.program_id = ?');
    binds.push(filters.programId);
  }
  if (filters.organizationId) {
    where.push('a.organization_id = ?');
    binds.push(filters.organizationId);
  }
  if (filters.status) {
    where.push('rp.status = ?');
    binds.push(filters.status);
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const sql = `
    SELECT rp.id AS reportPeriodId, rp.award_id AS awardId, rp.label, rp.period_type AS periodType,
           rp.due_date AS dueDate, rp.status,
           a.organization_id AS organizationId, a.awarded_amount_cents AS awardedAmountCents,
           o.legal_name AS organizationName, p.name AS programName,
           rs.submitted_at AS submittedAt, rs.funds_spent_cents AS fundsSpentCents
      FROM report_periods rp
      JOIN awards a ON a.id = rp.award_id
      JOIN organizations o ON o.id = a.organization_id
      JOIN programs p ON p.id = a.program_id
      LEFT JOIN report_submissions rs
             ON rs.id = (SELECT id FROM report_submissions
                          WHERE report_period_id = rp.id AND deleted_at IS NULL
                          ORDER BY submitted_at DESC LIMIT 1)
     WHERE ${where.join(' AND ')}
     ORDER BY rp.due_date, o.legal_name`;

  const { results } = await db
    .prepare(`${sql} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<Omit<PortfolioRow, 'daysUntilDue' | 'overdue'>>();

  const counted = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id
        WHERE ${where.join(' AND ')}`,
    )
    .bind(...binds)
    .first<{ n: number }>();

  const now = nowIso();
  let rows: PortfolioRow[] = (results ?? []).map((r) => ({
    ...r,
    daysUntilDue: daysUntilDue(r.dueDate, now),
    overdue: reportIsOverdue(r.status, r.dueDate, now),
  }));

  /*
   * Overdue is filtered in code, not in SQL.
   *
   * It depends on today's date and on the status together, and expressing that
   * as SQL means a date comparison against a string that D1 would evaluate per
   * row anyway. The cost is that `total` counts before this filter, which is
   * why the caller gets the filtered rows and the unfiltered total under
   * different names rather than one number that means neither.
   */
  if (filters.overdueOnly) rows = rows.filter((r) => r.overdue);

  return { rows, total: counted?.n ?? 0 };
}

export interface StaffAnswer {
  fieldKey: string;
  label: string;
  /** Already formatted for reading: cents as dollars, options as their labels. */
  display: string | null;
}

export interface StaffReport {
  period: {
    id: string;
    label: string;
    periodType: string;
    periodStart: string | null;
    periodEnd: string | null;
    dueDate: string;
    status: string;
    waivedReason: string | null;
  };
  award: {
    id: string;
    organizationId: string;
    organizationName: string;
    programName: string;
    awardedAmountCents: number;
    termStart: string | null;
    termEnd: string | null;
  };
  /** Newest first. A revision is a new submission, so there can be several. */
  submissions: {
    id: string;
    submittedAt: string;
    submittedBy: string | null;
    fundsSpentCents: number | null;
    adminFeedback: string | null;
    acceptedAt: string | null;
    answers: StaffAnswer[];
    metrics: { metricKey: string; label: string; display: string | null }[];
    attachments: { id: string; filename: string; sizeBytes: number }[];
  }[];
}

/** One report period, with every attempt against it, for staff to read. */
export async function readReportForStaff(
  db: D1Database,
  session: Session,
  reportPeriodId: string,
): Promise<StaffReport> {
  assertStaff(session);

  const period = await db
    .prepare(
      `SELECT rp.id, rp.label, rp.period_type, rp.period_start, rp.period_end, rp.due_date,
              rp.status, rp.waived_reason, rp.form_definition_id,
              a.id AS award_id, a.organization_id, a.awarded_amount_cents, a.term_start, a.term_end,
              o.legal_name, p.name AS program_name
         FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id AND a.deleted_at IS NULL
         JOIN organizations o ON o.id = a.organization_id
         JOIN programs p ON p.id = a.program_id
        WHERE rp.id = ? AND rp.deleted_at IS NULL`,
    )
    .bind(reportPeriodId)
    .first<Record<string, never>>() as Record<string, string | number | null> | null;

  if (!period) throw notFound('report period');

  const { results: submissionRows } = await db
    .prepare(
      `SELECT rs.id, rs.submitted_at, rs.funds_spent_cents, rs.admin_feedback, rs.accepted_at,
              u.email AS submitted_by
         FROM report_submissions rs
         LEFT JOIN users u ON u.id = rs.submitted_by_user_id
        WHERE rs.report_period_id = ? AND rs.deleted_at IS NULL
        ORDER BY rs.submitted_at DESC`,
    )
    .bind(reportPeriodId)
    .all<{
      id: string;
      submitted_at: string;
      funds_spent_cents: number | null;
      admin_feedback: string | null;
      accepted_at: string | null;
      submitted_by: string | null;
    }>();

  const definition = period.form_definition_id
    ? await loadFormDefinition(db, String(period.form_definition_id))
    : null;
  const fieldsById = new Map((definition ? allFields(definition) : []).map((f) => [f.id, f]));

  const submissions: StaffReport['submissions'] = [];
  for (const row of submissionRows ?? []) {
    const { results: answerRows } = await db
      .prepare(
        `SELECT form_field_id, value_text, value_int, value_real, value_json
           FROM report_answers WHERE report_submission_id = ?`,
      )
      .bind(row.id)
      .all<{ form_field_id: string } & StoredValue>();

    const answers: StaffAnswer[] = [];
    for (const a of answerRows ?? []) {
      const field = fieldsById.get(a.form_field_id);
      if (!field) continue;
      answers.push({
        fieldKey: field.field_key,
        label: field.label,
        // The same formatter the confirmation email uses, so staff and the
        // grantee read the same sentence for the same answer.
        display: displayValue(field, a),
      });
    }
    // Form order, not insertion order: a report read out of sequence is harder
    // to compare against the one filed last year.
    const order = new Map([...fieldsById.values()].map((f, i) => [f.field_key, i]));
    answers.sort((x, y) => (order.get(x.fieldKey) ?? 0) - (order.get(y.fieldKey) ?? 0));

    const { results: metricRows } = await db
      .prepare(
        `SELECT md.metric_key, md.label, md.metric_type, md.unit,
                mv.value_int, mv.value_real, mv.value_text
           FROM metric_values mv
           JOIN metric_definitions md ON md.id = mv.metric_definition_id
          WHERE mv.report_submission_id = ?
          ORDER BY md.sort_order, md.metric_key`,
      )
      .bind(row.id)
      .all<{
        metric_key: string;
        label: string;
        metric_type: string;
        unit: string | null;
        value_int: number | null;
        value_real: number | null;
        value_text: string | null;
      }>();

    const { results: attachmentRows } = await db
      .prepare(
        `SELECT id, filename, size_bytes FROM attachments
          WHERE parent_type = 'report_submission' AND parent_id = ? AND deleted_at IS NULL
          ORDER BY uploaded_at`,
      )
      .bind(row.id)
      .all<{ id: string; filename: string; size_bytes: number }>();

    submissions.push({
      id: row.id,
      submittedAt: row.submitted_at,
      submittedBy: row.submitted_by,
      fundsSpentCents: row.funds_spent_cents,
      adminFeedback: row.admin_feedback,
      acceptedAt: row.accepted_at,
      answers,
      metrics: (metricRows ?? []).map((m) => ({
        metricKey: m.metric_key,
        label: m.label,
        display: formatMetric(m),
      })),
      attachments: (attachmentRows ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        sizeBytes: a.size_bytes,
      })),
    });
  }

  return {
    period: {
      id: String(period.id),
      label: String(period.label),
      periodType: String(period.period_type),
      periodStart: period.period_start as string | null,
      periodEnd: period.period_end as string | null,
      dueDate: String(period.due_date),
      status: String(period.status),
      waivedReason: period.waived_reason as string | null,
    },
    award: {
      id: String(period.award_id),
      organizationId: String(period.organization_id),
      organizationName: String(period.legal_name),
      programName: String(period.program_name),
      awardedAmountCents: Number(period.awarded_amount_cents),
      termStart: period.term_start as string | null,
      termEnd: period.term_end as string | null,
    },
    submissions,
  };
}

/** One metric value as a sentence. Cents become dollars exactly once, here. */
function formatMetric(m: {
  metric_type: string;
  unit: string | null;
  value_int: number | null;
  value_real: number | null;
  value_text: string | null;
}): string | null {
  const unit = m.unit ? ` ${m.unit}` : '';
  if (m.metric_type === 'currency') {
    return m.value_int === null
      ? null
      : `$${(m.value_int / 100).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
  }
  if (m.value_int !== null) return `${m.value_int.toLocaleString('en-US')}${unit}`;
  if (m.value_real !== null) {
    return `${m.value_real.toLocaleString('en-US', { maximumFractionDigits: 6 })}${unit}`;
  }
  return m.value_text;
}

/** The latest submission against a period, or null when nothing was filed. */
async function latestSubmission(
  db: D1Database,
  reportPeriodId: string,
): Promise<{ id: string; accepted_at: string | null } | null> {
  return await db
    .prepare(
      `SELECT id, accepted_at FROM report_submissions
        WHERE report_period_id = ? AND deleted_at IS NULL
        ORDER BY submitted_at DESC LIMIT 1`,
    )
    .bind(reportPeriodId)
    .first<{ id: string; accepted_at: string | null }>();
}

/**
 * Accept a filed report.
 *
 * Terminal, and 0012's trigger enforces it: an accepted period cannot be
 * reopened, because doing so would let a submission be replaced after staff
 * signed it off with the acceptance still on the row.
 */
export async function acceptReport(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
): Promise<{ reportSubmissionId: string; acceptedAt: string }> {
  assertAdmin(session);

  const period = await db
    .prepare(`SELECT id, status FROM report_periods WHERE id = ? AND deleted_at IS NULL`)
    .bind(reportPeriodId)
    .first<{ id: string; status: string }>();
  if (!period) throw notFound('report period');

  if (period.status !== 'submitted') {
    throw new AppError('CONFLICT', `A report in "${period.status}" cannot be accepted.`, {
      internalMessage: `accept attempted on report period ${reportPeriodId} in ${period.status}`,
      severity: 'warn',
    });
  }

  const submission = await latestSubmission(db, reportPeriodId);
  if (!submission) {
    // Unreachable through the app -- the status only becomes 'submitted' in the
    // same batch that writes a submission -- and worth refusing rather than
    // accepting nothing.
    throw new AppError('CONFLICT', 'There is nothing filed against this report.', {
      internalMessage: `report period ${reportPeriodId} is submitted with no submission row`,
      severity: 'error',
    });
  }

  const now = nowIso();
  const guard = `(SELECT status FROM report_periods WHERE id = ?) = 'submitted'`;

  const results = await db.batch([
    db
      .prepare(
        `UPDATE report_submissions SET accepted_at = ?, accepted_by = ?, updated_at = ?
          WHERE id = ? AND accepted_at IS NULL AND ${guard}`,
      )
      .bind(now, session.userId, now, submission.id, reportPeriodId),
    auditStatement(db, ctx, {
      action: 'report.accepted',
      entityType: 'report_submission',
      entityId: submission.id,
      before: { status: 'submitted' },
      after: { status: 'accepted', report_period_id: reportPeriodId, accepted_by: session.userId },
    }, { guard: { sql: guard, binds: [reportPeriodId] } }),
    // LAST, so its row count answers whether this call did anything.
    db
      .prepare(
        `UPDATE report_periods SET status = 'accepted', updated_at = ?
          WHERE id = ? AND status = 'submitted' AND deleted_at IS NULL`,
      )
      .bind(now, reportPeriodId),
  ]);

  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    throw new AppError('CONFLICT', 'This report was already decided.', {
      internalMessage: `accept on report period ${reportPeriodId} lost a race`,
      severity: 'warn',
    });
  }

  return { reportSubmissionId: submission.id, acceptedAt: now };
}

/**
 * Send a report back with feedback.
 *
 * The feedback is REQUIRED. Sending a nonprofit's report back with no
 * explanation is the thing this endpoint exists to prevent, not a case it
 * tolerates -- they cannot act on "changes requested", and the person who has
 * to ask what was meant is a program director, by email, a week later.
 *
 * It is written on the SUBMISSION being sent back, not on the period, so the
 * next attempt carries its own record of what was asked and what was answered.
 */
export async function requestReportRevisions(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
  feedback: string,
): Promise<{ reportSubmissionId: string }> {
  assertAdmin(session);

  const note = feedback.trim();
  if (note.length < 10) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Say what needs to change. A grantee cannot act on "changes requested".',
      {
        internalMessage: `revision request on ${reportPeriodId} with ${note.length} characters`,
        severity: 'warn',
        fieldErrors: [{ field: 'feedback', message: 'Tell them what to change.' }],
      },
    );
  }
  if (note.length > 4000) {
    throw new AppError('VALIDATION_FAILED', 'That note is too long to send.', {
      internalMessage: `revision request on ${reportPeriodId} is ${note.length} characters`,
      severity: 'warn',
    });
  }

  const period = await db
    .prepare(`SELECT id, status FROM report_periods WHERE id = ? AND deleted_at IS NULL`)
    .bind(reportPeriodId)
    .first<{ id: string; status: string }>();
  if (!period) throw notFound('report period');
  if (period.status !== 'submitted') {
    throw new AppError('CONFLICT', `A report in "${period.status}" cannot be sent back.`, {
      internalMessage: `revisions requested on ${reportPeriodId} in ${period.status}`,
      severity: 'warn',
    });
  }

  const submission = await latestSubmission(db, reportPeriodId);
  if (!submission) throw notFound('report submission');

  const now = nowIso();
  const guard = `(SELECT status FROM report_periods WHERE id = ?) = 'submitted'`;

  const results = await db.batch([
    db
      .prepare(
        `UPDATE report_submissions SET admin_feedback = ?, updated_at = ?
          WHERE id = ? AND ${guard}`,
      )
      .bind(note, now, submission.id, reportPeriodId),
    auditStatement(db, ctx, {
      action: 'report.revisions_requested',
      entityType: 'report_submission',
      entityId: submission.id,
      before: { status: 'submitted' },
      after: {
        status: 'revisions_requested',
        report_period_id: reportPeriodId,
        // The LENGTH, not the text. The feedback lives on the submission row
        // where the grantee reads it; the audit records that it was sent.
        feedback_characters: note.length,
      },
    }, { guard: { sql: guard, binds: [reportPeriodId] } }),
    db
      .prepare(
        `UPDATE report_periods SET status = 'revisions_requested', updated_at = ?
          WHERE id = ? AND status = 'submitted' AND deleted_at IS NULL`,
      )
      .bind(now, reportPeriodId),
  ]);

  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    throw new AppError('CONFLICT', 'This report was already decided.', {
      internalMessage: `revision request on ${reportPeriodId} lost a race`,
      severity: 'warn',
    });
  }

  return { reportSubmissionId: submission.id };
}

/**
 * Waive a report.
 *
 * A deliberate act with a reason, never a quiet delete -- the schema refuses a
 * waived period with no reason. Real grant administration does this: a grant
 * returned unspent, a program that closed, an obligation superseded by a
 * renewal.
 */
export async function waiveReport(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
  reason: string,
): Promise<void> {
  assertAdmin(session);

  const note = reason.trim();
  if (note.length < 5) {
    throw new AppError('VALIDATION_FAILED', 'Say why this report is not required.', {
      internalMessage: `waive on ${reportPeriodId} with ${note.length} characters`,
      severity: 'warn',
      fieldErrors: [{ field: 'reason', message: 'A waiver needs a reason.' }],
    });
  }

  const period = await db
    .prepare(`SELECT id, status FROM report_periods WHERE id = ? AND deleted_at IS NULL`)
    .bind(reportPeriodId)
    .first<{ id: string; status: string }>();
  if (!period) throw notFound('report period');
  if (period.status === 'accepted' || period.status === 'waived') {
    throw new AppError('CONFLICT', `This report is already ${period.status}.`, {
      internalMessage: `waive attempted on ${reportPeriodId} in ${period.status}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  const results = await db.batch([
    auditStatement(db, ctx, {
      action: 'report.waived',
      entityType: 'report_period',
      entityId: reportPeriodId,
      before: { status: period.status },
      after: { status: 'waived', reason: note },
    }, {
      guard: {
        sql: `(SELECT status FROM report_periods WHERE id = ?) NOT IN ('accepted','waived')`,
        binds: [reportPeriodId],
      },
    }),
    db
      .prepare(
        `UPDATE report_periods SET status = 'waived', waived_reason = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('accepted','waived') AND deleted_at IS NULL`,
      )
      .bind(note, now, reportPeriodId),
  ]);

  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    throw new AppError('CONFLICT', 'This report was already decided.', {
      internalMessage: `waive on ${reportPeriodId} lost a race`,
      severity: 'warn',
    });
  }
}
