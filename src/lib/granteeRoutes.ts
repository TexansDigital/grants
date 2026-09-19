/**
 * The grantee portal's API.
 *
 * ONE PAGE. CLAUDE.md is explicit about it: "your award, the amount, what is
 * due when, one button to file the open report. Over three clicks to submit is
 * a design failure." So there is one read endpoint that returns everything that
 * page needs, rather than four the client has to stitch together while a
 * program director waits on a phone.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY PAYLOAD HERE. No reviewer score, no
 * internal note, no decision rationale, no other organization's anything.
 * Not hidden in the UI -- not in the response. The two award columns a grantee
 * does see are their own amount and their own term; `awards.notes` and
 * `report_submissions` staff columns other than admin_feedback are never
 * selected. admin_feedback is the one staff field written for the grantee to
 * read, which is why it is here and why it is named.
 *
 * SCOPING is the session's organization, applied in SQL, on every query. An id
 * in a URL narrows; it never widens. A miss is 404.
 */

import type { Env, RequestContext, Session } from '../types';
import { notFound } from './errors';
import { sessionOrgId } from './scope';
import { loadFormDefinition } from './loadForm';
import { allFields } from './forms';
import {
  loadGranteePeriod, loadOpenDraft, draftAnswers, isPeriodFileable,
  saveReportDraft, submitReport,
} from './reportSubmit';
import { nowIso, formatInZone } from './time';
import { sendEmail, transportFor, type EmailTransport } from './email';
import { REPORT_RECEIVED } from './emailTemplates';
import { readBackLines } from './answerDisplay';
import { formatCents } from './money';
import { logError } from './errors';
import type { StoredValue } from './fieldTypes';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

interface AwardRow {
  id: string;
  program_name: string;
  awarded_amount_cents: number;
  awarded_at: string;
  term_start: string | null;
  term_end: string | null;
  status: string;
}

interface PeriodRow {
  id: string;
  award_id: string;
  label: string;
  period_type: string;
  period_start: string | null;
  period_end: string | null;
  opens_at: string | null;
  due_date: string;
  status: string;
  form_definition_id: string | null;
  submitted_at: string | null;
  admin_feedback: string | null;
}

/** What the grantee is being asked to do about one report, in plain words. */
export type ReportState =
  | 'open'
  | 'not_open_yet'
  | 'in_progress'
  | 'submitted'
  | 'changes_requested'
  | 'accepted'
  | 'waived'
  | 'no_form_yet';

export function reportState(
  period: Pick<PeriodRow, 'status' | 'opens_at' | 'form_definition_id'>,
  hasDraft: boolean,
  now: string = nowIso(),
): ReportState {
  if (period.status === 'accepted') return 'accepted';
  if (period.status === 'waived') return 'waived';
  if (period.status === 'submitted') return 'submitted';
  if (period.status === 'revisions_requested') return 'changes_requested';
  if (!isPeriodFileable(period, now)) return 'not_open_yet';
  // Checked AFTER openness: telling somebody a form is missing on a report
  // that is not due for eight months is noise about a problem that is ours.
  if (!period.form_definition_id) return 'no_form_yet';
  return hasDraft ? 'in_progress' : 'open';
}

/** Is this something the grantee still has to do? */
export function isOutstanding(state: ReportState): boolean {
  return state === 'open' || state === 'in_progress' || state === 'changes_requested';
}

/**
 * GET /api/grantee/home — everything the one page needs.
 *
 * Three queries, not one per award: an organization with four multi-year
 * awards would otherwise make a dozen round-trips to render a page somebody is
 * looking at on a phone.
 */
export async function granteeHome(env: Env, session: Session): Promise<Response> {
  const organizationId = sessionOrgId(session);

  const { results: awards } = await env.DB.prepare(
    `SELECT a.id, p.name AS program_name, a.awarded_amount_cents, a.awarded_at,
            a.term_start, a.term_end, a.status
       FROM awards a
       JOIN programs p ON p.id = a.program_id
      WHERE a.organization_id = ? AND a.deleted_at IS NULL AND a.status <> 'cancelled'
      ORDER BY a.awarded_at DESC`,
  )
    .bind(organizationId)
    .all<AwardRow>();

  if ((awards ?? []).length === 0) {
    const organization = await env.DB.prepare(
      `SELECT legal_name FROM organizations WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(organizationId)
      .first<{ legal_name: string }>();
    return json({ organization: { name: organization?.legal_name ?? null }, awards: [] });
  }

  /*
   * The periods, and the latest submission against each.
   *
   * A LEFT JOIN on report_submissions would multiply a period by its attempts;
   * a revised report would appear three times. The subquery takes the most
   * recent attempt, which is the one carrying the feedback a grantee needs to
   * read before they refile.
   */
  const { results: periods } = await env.DB.prepare(
    `SELECT rp.id, rp.award_id, rp.label, rp.period_type, rp.period_start, rp.period_end,
            rp.opens_at, rp.due_date, rp.status, rp.form_definition_id,
            rs.submitted_at, rs.admin_feedback
       FROM report_periods rp
       JOIN awards a ON a.id = rp.award_id
       LEFT JOIN report_submissions rs
              ON rs.id = (SELECT id FROM report_submissions
                           WHERE report_period_id = rp.id AND deleted_at IS NULL
                           ORDER BY submitted_at DESC LIMIT 1)
      WHERE a.organization_id = ? AND a.deleted_at IS NULL AND rp.deleted_at IS NULL
      ORDER BY rp.due_date`,
  )
    .bind(organizationId)
    .all<PeriodRow>();

  const { results: drafts } = await env.DB.prepare(
    `SELECT rp.id AS report_period_id
       FROM report_drafts rd
       JOIN report_periods rp ON rp.id = rd.report_period_id
       JOIN awards a ON a.id = rp.award_id
      WHERE a.organization_id = ? AND rd.submitted_at IS NULL AND rd.deleted_at IS NULL`,
  )
    .bind(organizationId)
    .all<{ report_period_id: string }>();
  const hasDraft = new Set((drafts ?? []).map((d) => d.report_period_id));

  const now = nowIso();
  const periodsByAward = new Map<string, unknown[]>();
  for (const p of periods ?? []) {
    const state = reportState(p, hasDraft.has(p.id), now);
    const list = periodsByAward.get(p.award_id) ?? [];
    list.push({
      id: p.id,
      label: p.label,
      type: p.period_type,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      dueDate: p.due_date,
      opensAt: p.opens_at,
      state,
      outstanding: isOutstanding(state),
      submittedAt: p.submitted_at,
      // The one staff-written field a grantee is meant to read. Present only
      // when there is something to say, so the client has no empty panel to
      // render and no reason to guess.
      feedback: state === 'changes_requested' ? p.admin_feedback : null,
    });
    periodsByAward.set(p.award_id, list);
  }

  const organization = await env.DB.prepare(
    `SELECT legal_name FROM organizations WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(organizationId)
    .first<{ legal_name: string }>();

  return json({
    organization: { name: organization?.legal_name ?? null },
    awards: (awards ?? []).map((a) => ({
      id: a.id,
      program: a.program_name,
      amountCents: a.awarded_amount_cents,
      awardedAt: a.awarded_at,
      termStart: a.term_start,
      termEnd: a.term_end,
      status: a.status,
      reports: periodsByAward.get(a.id) ?? [],
    })),
  });
}

/** GET /api/grantee/reports/:id — the form, and whatever is already typed. */
export async function readReport(
  env: Env,
  session: Session,
  reportPeriodId: string,
): Promise<Response> {
  const period = await loadGranteePeriod(env.DB, session, reportPeriodId);
  const draft = await loadOpenDraft(env.DB, reportPeriodId);
  const state = reportState(period, draft !== null);

  const award = await env.DB.prepare(
    `SELECT p.name AS program_name, a.awarded_amount_cents, a.term_start, a.term_end
       FROM awards a JOIN programs p ON p.id = a.program_id
      WHERE a.id = ?`,
  )
    .bind(period.award_id)
    .first<{
      program_name: string;
      awarded_amount_cents: number;
      term_start: string | null;
      term_end: string | null;
    }>();

  const latest = await env.DB.prepare(
    `SELECT admin_feedback FROM report_submissions
      WHERE report_period_id = ? AND deleted_at IS NULL
      ORDER BY submitted_at DESC LIMIT 1`,
  )
    .bind(reportPeriodId)
    .first<{ admin_feedback: string | null }>();

  const body: Record<string, unknown> = {
    report: {
      id: period.id,
      label: period.label,
      type: period.period_type,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      dueDate: period.due_date,
      state,
      canFile: isOutstanding(state),
      feedback: state === 'changes_requested' ? (latest?.admin_feedback ?? null) : null,
      savedAt: draft?.updated_at ?? null,
    },
    award: {
      program: award?.program_name ?? null,
      amountCents: award?.awarded_amount_cents ?? null,
      termStart: award?.term_start ?? null,
      termEnd: award?.term_end ?? null,
    },
    answers: draft ? draftAnswers(draft) : {},
  };

  // The form is sent only when there is one and it can be filled in. A closed
  // report renders as a statement, not as a disabled form somebody will try to
  // type into.
  if (period.form_definition_id && isOutstanding(state)) {
    const definition = await loadFormDefinition(env.DB, period.form_definition_id);
    body.form = definition;
    // Field keys the page may upload against, so the client never has to infer
    // it from the field type.
    body.uploadFields = allFields(definition)
      .filter((f) => f.field_type === 'file_upload')
      .map((f) => f.field_key);
  }

  return json(body);
}

/** PATCH /api/grantee/reports/:id/draft — autosave. */
export async function autosaveReport(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { answers?: unknown };
  const answers =
    typeof body.answers === 'object' && body.answers !== null && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};

  // saveReportDraft does the scoping, the fileable check, the partial
  // validation and the audit. This route is plumbing, not a second copy.
  const result = await saveReportDraft(env.DB, ctx, session, reportPeriodId, answers);
  return json({ savedAt: result.savedAt, errors: result.errors });
}

/** POST /api/grantee/reports/:id/submit — file it. */
export async function fileReport(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { answers?: unknown };
  const answers =
    typeof body.answers === 'object' && body.answers !== null && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};

  const result = await submitReport(env.DB, ctx, session, reportPeriodId, answers);

  // After the write, and never awaited for a value that could change the
  // response. The report is committed; the receipt is a courtesy that must not
  // be able to turn a successful filing into a 500.
  await sendReportConfirmation(
    env, ctx, session, reportPeriodId, result.reportSubmissionId, result.submittedAt,
  );

  return json(
    {
      reportSubmissionId: result.reportSubmissionId,
      submittedAt: result.submittedAt,
      metricsRecorded: result.metricsRecorded,
    },
    201,
  );
}

/** A grantee's own identity, for the page header. Nothing about anyone else. */
export async function granteeMe(env: Env, session: Session): Promise<Response> {
  const organizationId = sessionOrgId(session);
  const organization = await env.DB.prepare(
    `SELECT legal_name FROM organizations WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(organizationId)
    .first<{ legal_name: string }>();
  if (!organization) throw notFound('organization');
  return json({
    user: { email: session.email, role: session.role },
    organization: { name: organization.legal_name },
  });
}

/**
 * The receipt for a filed report.
 *
 * NEVER BLOCKS THE FILING. The report is already committed by the time this
 * runs; a mail failure that propagated would turn a successful filing into a
 * 500, and a grantee who sees a 500 files again. So every path here swallows
 * into the error log, and the caller does not await a result it could act on.
 *
 * Also deliberately not a decision. It says we have it -- never that it is
 * accepted -- because acceptance is a staff act with its own record and a
 * receipt that reads like approval is one somebody will quote back.
 */
export async function sendReportConfirmation(
  env: Env,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
  reportSubmissionId: string,
  submittedAt: string,
  /**
   * A stand-in transport, for tests that need to read what was actually
   * rendered. The recorded message row keeps only a subject -- deliberately,
   * since it is an operational log -- so without this seam nothing can assert
   * that the read-back or the formatted amount reached the recipient, and
   * mutants that emptied both survived.
   */
  opts: { transport?: EmailTransport | null } = {},
): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT rp.label, rp.form_definition_id,
              p.name AS program_name, o.legal_name AS organization_name,
              a.awarded_amount_cents
         FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id
         JOIN organizations o ON o.id = a.organization_id
         JOIN programs p ON p.id = a.program_id
        WHERE rp.id = ? AND a.organization_id = ?`,
    )
      .bind(reportPeriodId, sessionOrgId(session))
      .first<{
        label: string;
        form_definition_id: string | null;
        program_name: string;
        organization_name: string;
        awarded_amount_cents: number;
      }>();
    if (!row || !row.form_definition_id) return;

    const definition = await loadFormDefinition(env.DB, row.form_definition_id);
    const byId = new Map(allFields(definition).map((f) => [f.id, f]));

    // Re-read what was PERSISTED, not what the request intended to persist. A
    // receipt built from the request body is a receipt for the request, and
    // the two are only the same when nothing went wrong.
    const { results } = await env.DB.prepare(
      `SELECT form_field_id, value_text, value_int, value_real, value_json
         FROM report_answers WHERE report_submission_id = ?`,
    )
      .bind(reportSubmissionId)
      .all<{ form_field_id: string } & StoredValue>();

    const stored = new Map<string, StoredValue>();
    for (const r of results ?? []) {
      if (!byId.has(r.form_field_id)) continue;
      stored.set(r.form_field_id, {
        value_text: r.value_text,
        value_int: r.value_int,
        value_real: r.value_real,
        value_json: r.value_json,
      });
    }

    await sendEmail(
      env,
      ctx,
      {
        template: REPORT_RECEIVED,
        to: session.email,
        // One receipt per submission, forever. A retry cannot produce a second
        // copy in the grantee's inbox -- and a REVISION is a new submission,
        // so it correctly gets its own.
        idempotencyKey: `report_received:${reportSubmissionId}`,
        vars: {
          organizationName: row.organization_name,
          programName: row.program_name,
          reportLabel: row.label,
          // The display edge. Cents become dollars here and nowhere earlier.
          awardAmount: formatCents(row.awarded_amount_cents),
          submittedAtDisplay: formatInZone(submittedAt, env.DISPLAY_TIMEZONE),
          answers: readBackLines(definition, stored),
        },
        // Entity ids only. The read-back is never stored on the message row --
        // it is the grantee's own detail and email_messages is an operational
        // log read by more people than need it.
        context: {
          report_period_id: reportPeriodId,
          report_submission_id: reportSubmissionId,
        },
      },
      opts.transport === undefined ? transportFor(env) : opts.transport,
    );
  } catch (err) {
    await logError(env, ctx, {
      code: 'REPORT_CONFIRMATION_EMAIL_FAILED',
      severity: 'error',
      message:
        err instanceof Error
          ? `report receipt failed after a successful filing: ${err.message}`
          : 'report receipt failed after a successful filing',
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { report_period_id: reportPeriodId },
    });
  }
}
