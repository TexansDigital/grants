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
import { sessionOrgId, listApplicationsForExternal } from './scope';
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

/**
 * Which STEP each application is, and whether another one follows it.
 *
 * WHY THE PORTAL NEEDS THIS. A program with an eligibility screen produces two
 * applications for one grant request, and both are rows in `applications`. The
 * portal used to render a submitted eligibility screen as "Grant application —
 * Received. We have it. You do not need to do anything else for now." Every
 * word of that is wrong for the person reading it: it is not the grant
 * application, and they very much do need to do something else.
 *
 * Fetched separately and joined in memory, for the same reason the program and
 * cycle names are: a stage name is not sensitive, but it is not on the
 * applicant column allowlist either, and widening that list to carry display
 * text would make it mean "safe to send, plus these" rather than what it means
 * now.
 */
interface StageLabel {
  stageName: string | null;
  /** False when a later stage exists in the same program. */
  isFinalStage: boolean;
  /** Needed to tell whether a LATER stage has already been started. */
  sortOrder: number;
}

async function stageLabels(
  db: D1Database,
  stageIds: string[],
): Promise<Map<string, StageLabel>> {
  const out = new Map<string, StageLabel>();
  const ids = [...new Set(stageIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT ps.id, ps.name, ps.sort_order,
              /*
               * A later stage counts only if it has a PUBLISHED form. A stage
               * configured but not yet built is not a step anybody can take,
               * and telling an applicant there is more to do when there is
               * nowhere to do it is worse than saying nothing.
               */
              EXISTS (SELECT 1 FROM program_stages later
                        JOIN form_definitions fd
                          ON fd.stage_id = later.id AND fd.status = 'published'
                         AND fd.deleted_at IS NULL
                       WHERE later.program_id = ps.program_id
                         AND later.deleted_at IS NULL
                         AND later.sort_order > ps.sort_order) AS has_later
         FROM program_stages ps
        WHERE ps.id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<{ id: string; name: string; sort_order: number; has_later: number }>();
  for (const r of results ?? []) {
    out.set(r.id, {
      stageName: r.name,
      isFinalStage: r.has_later === 0,
      sortOrder: Number(r.sort_order),
    });
  }
  return out;
}

/**
 * Has this organization already started a LATER stage of the same cycle?
 *
 * WHY IT MATTERS. `isFinalStage` says a next step exists; it does not say
 * whether the person has taken it. Without this the portal kept offering
 * "Continue your application" after the application had been started, and the
 * endpoint behind it answers 409 -- so the button was an invitation to an
 * error. Caught by driving the page twice, which no unit test was doing.
 */
function laterStageStarted(
  row: Record<string, unknown>,
  all: Record<string, unknown>[],
  stages: Map<string, StageLabel>,
): boolean {
  const mine = stages.get(String(row.stage_id ?? ''));
  if (!mine) return false;
  return all.some((other) => {
    if (other === row) return false;
    if (String(other.cycle_id ?? '') !== String(row.cycle_id ?? '')) return false;
    const theirs = stages.get(String(other.stage_id ?? ''));
    return theirs !== undefined && theirs.sortOrder > mine.sortOrder;
  });
}

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
    /*
     * NO AWARDS IS NOT NO APPLICATIONS. This early return existed because the
     * page was only ever about grants; an applicant who has applied and holds
     * nothing yet is the commonest visitor to it, and this branch was sending
     * them an empty page.
     */
    const applications = await listApplicationsForExternal(env.DB, session);
    const stages = await stageLabels(
      env.DB,
      applications.map((a) => String(a.stage_id ?? '')),
    );
    return json({
      organization: { name: organization?.legal_name ?? null },
      awards: [],
      applications: applications.map((a) => ({
        id: String(a.id),
        status: String(a.status ?? ''),
        projectTitle: a.project_title === null ? null : String(a.project_title),
        submittedAt: a.submitted_at === null ? null : String(a.submitted_at),
        updatedAt: a.updated_at === null ? null : String(a.updated_at),
        programName: null,
        cycleName: null,
        /*
         * WHICH CYCLE, and it is not decoration. The portal offers to start
         * the next stage of an application, and it has to name the cycle that
         * application belongs to. Taking the first open cycle instead -- which
         * is what the first version of that button did -- starts the wrong
         * programme's first stage the moment two cycles are open at once.
         */
        cycleId: a.cycle_id === null ? null : String(a.cycle_id),
        stageName: stages.get(String(a.stage_id ?? ''))?.stageName ?? null,
        isFinalStage: stages.get(String(a.stage_id ?? ''))?.isFinalStage ?? true,
        nextStageStarted: laterStageStarted(a, applications, stages),
      })),
    });
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

  /*
   * WHAT THEY FILED WITH IT.
   *
   * A grantee could attach documents to a report and never see them again --
   * the same gap the application form had. "Did I send the right budget?" is
   * asked most often AFTER submitting, which is exactly when nothing on the
   * page could answer it.
   *
   * WHAT ACTUALLY SCOPES THIS, said accurately because a mutant proved the
   * obvious answer wrong. The output is scoped by the PERIOD LIST built above,
   * which is already restricted to this organization's awards: a file is only
   * ever attached to a report this grantee can see, so removing the
   * organization_id clause below leaks nothing and no test catches it.
   *
   * It stays anyway, and not as decoration. Without it this query reads every
   * report attachment in the database on every portal page load, and a
   * grouping bug in the lines beneath it would then have another
   * organization's filenames already in memory to leak. The cheap version of
   * that mistake is a slow page; the expensive one is a filename on somebody
   * else's screen.
   *
   * The ids this returns are in any case the only ones the portal download
   * route will honour for this session -- it re-checks ownership itself.
   *
   * Only the LATEST submission's files, matching the row above it. A revised
   * report's earlier attempts are history; showing three budgets under one
   * report period asks the grantee to work out which one counts.
   */
  const { results: files } = await env.DB.prepare(
    `SELECT rs.report_period_id, at.id, at.filename, at.size_bytes
       FROM attachments at
       JOIN report_submissions rs ON rs.id = at.parent_id
       JOIN report_periods rp     ON rp.id = rs.report_period_id
       JOIN awards a              ON a.id = rp.award_id
      WHERE at.parent_type = 'report_submission'
        AND at.deleted_at IS NULL
        AND at.purged_at IS NULL
        AND rs.deleted_at IS NULL AND rp.deleted_at IS NULL AND a.deleted_at IS NULL
        AND a.organization_id = ?
        AND rs.id = (SELECT id FROM report_submissions
                      WHERE report_period_id = rp.id AND deleted_at IS NULL
                      ORDER BY submitted_at DESC LIMIT 1)
      ORDER BY at.uploaded_at`,
  )
    .bind(organizationId)
    .all<{ report_period_id: string; id: string; filename: string; size_bytes: number }>();

  const filesByPeriod = new Map<string, { id: string; filename: string; sizeBytes: number }[]>();
  for (const f of files ?? []) {
    const list = filesByPeriod.get(f.report_period_id) ?? [];
    list.push({ id: f.id, filename: f.filename, sizeBytes: f.size_bytes });
    filesByPeriod.set(f.report_period_id, list);
  }

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
      attachments: filesByPeriod.get(p.id) ?? [],
    });
    periodsByAward.set(p.award_id, list);
  }

  const organization = await env.DB.prepare(
    `SELECT legal_name FROM organizations WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(organizationId)
    .first<{ legal_name: string }>();

  /*
   * THEIR APPLICATIONS, WHICH THIS PAGE HAS NEVER SHOWN.
   *
   * `listApplicationsForExternal` was written in Phase 1, correctly scoped and
   * correctly masked, and nothing ever called it. So an applicant who
   * submitted and then closed the tab had no page anywhere that said so: the
   * portal listed awards and nothing else, the read-back lived at a URL they
   * would have had to keep, and signing in again landed them on "there are no
   * grants on this account yet". The single most common question an applicant
   * has after submitting -- did it go through -- had no answer in the product.
   *
   * THE STATUS IS MASKED BY THAT FUNCTION, and that is why this uses it rather
   * than a query written here. An application becomes 'declined' the moment an
   * admin records the decision, days before a human finishes the letter; the
   * applicant sees 'under_review' until somebody has actually told them.
   * Re-implementing the read here would be re-implementing that rule, and
   * getting it wrong is a nonprofit learning it was declined from a badge.
   *
   * The program and cycle NAMES are fetched separately and joined in memory.
   * They are public -- they are on the open-cycles page for anyone to read --
   * but they are not on the applicant column allowlist, and widening that list
   * to carry them would make it mean "safe to send, plus these" rather than
   * what it means now.
   */
  const applications = await listApplicationsForExternal(env.DB, session);
  const cycleIds = [...new Set(applications.map((a) => String(a.cycle_id ?? '')).filter(Boolean))];
  const cycleNames = new Map<string, { cycleName: string; programName: string }>();
  if (cycleIds.length > 0) {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.name AS cycleName, p.name AS programName
         FROM cycles c JOIN programs p ON p.id = c.program_id
        WHERE c.id IN (${cycleIds.map(() => '?').join(',')})`,
    )
      .bind(...cycleIds)
      .all<{ id: string; cycleName: string; programName: string }>();
    for (const r of results ?? []) {
      cycleNames.set(r.id, { cycleName: r.cycleName, programName: r.programName });
    }
  }

  const stages = await stageLabels(env.DB, applications.map((a) => String(a.stage_id ?? '')));

  return json({
    organization: { name: organization?.legal_name ?? null },
    applications: applications.map((a) => ({
      id: String(a.id),
      status: String(a.status ?? ''),
      projectTitle: a.project_title === null ? null : String(a.project_title),
      submittedAt: a.submitted_at === null ? null : String(a.submitted_at),
      updatedAt: a.updated_at === null ? null : String(a.updated_at),
      programName: cycleNames.get(String(a.cycle_id ?? ''))?.programName ?? null,
      cycleName: cycleNames.get(String(a.cycle_id ?? ''))?.cycleName ?? null,
      cycleId: a.cycle_id === null ? null : String(a.cycle_id),
      stageName: stages.get(String(a.stage_id ?? ''))?.stageName ?? null,
      isFinalStage: stages.get(String(a.stage_id ?? ''))?.isFinalStage ?? true,
      nextStageStarted: laterStageStarted(a, applications, stages),
    })),
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
