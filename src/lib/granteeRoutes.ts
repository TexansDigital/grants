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
import { nowIso } from './time';

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
