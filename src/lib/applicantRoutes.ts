/**
 * The applicant's own application: create, read, autosave.
 *
 * DECISION: a draft lives on the SERVER from the moment it exists.
 *
 * The renderer previously kept answers in localStorage under a key derived
 * from the form id. That is honest about itself -- the indicator says "Saved
 * in this browser" -- but nobody reads it that way. They read the word
 * "Saved". An executive director starting on a phone at 9pm and continuing on
 * a laptop the next morning lost everything, and so did anyone who opened the
 * link a second time in the in-app browser inside Gmail rather than in Safari.
 * For a form asking for three thousand words, that is the difference between
 * an application and an abandoned one.
 *
 * SCOPING. Every query here is scoped by the organization id on the SESSION,
 * never by anything in the request. Changing an id in a URL returns 404, not
 * 403 -- a 403 would confirm that somebody else's application exists.
 *
 * CONCURRENT EDITS are last-write-wins PER FIELD, not per form. Two devices
 * editing different sections merge cleanly because answers are upserted one
 * field at a time; two devices editing the SAME field, the later write wins.
 * CLAUDE.md is explicit that there is no real-time collaboration here, and
 * optimistic locking on a draft would mean showing a nonprofit a merge
 * conflict dialog, which is worse than the problem.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { allFields } from './forms';
import { loadFormDefinition } from './loadForm';
import { saveDraft, submitApplication, loadStoredAnswers } from './submit';
import { sendEmail, transportFor } from './email';
import { APPLICATION_RECEIVED } from './emailTemplates';
import { readBackLines } from './answerDisplay';
import { formatCents } from './money';
import { formatInZone } from './time';
import { logError } from './errors';
import { isAcceptingApplications } from './eligibility';

function orgId(session: Session): string {
  if (!session.organizationId) {
    // Unreachable: resolveSession refuses a session without one. Failing here
    // beats running an unscoped query.
    throw new AppError('FORBIDDEN', 'This account is not linked to an organization.', {
      internalMessage: 'applicant session with no organization_id reached a scoped route',
      severity: 'error',
    });
  }
  return session.organizationId;
}

interface StageRow {
  stage_id: string;
  stage_key: string;
  sort_order: number;
  gate_on_prior_decision: number;
  form_definition_id: string;
}

/**
 * Statuses at a prior stage that satisfy a gate.
 *
 * INTERPRETATION, stated because `gate_on_prior_decision` does not define it:
 * an eligibility screen has no reviewer, so passing it IS the decision, and a
 * submitted eligibility application opens the stage behind it.
 *
 * 'declined' and 'withdrawn' are deliberately absent. A program that needs
 * genuine invite-only semantics -- an LOI a human reads, then invites -- needs
 * more than this, and will get it when review exists. Saying so here beats
 * discovering later that "gated" quietly meant "anyone who submitted".
 */
const GATE_SATISFYING = ['submitted', 'under_review', 'awarded'] as const;

/** POST /api/applications — start the full application for an open cycle. */
export async function createApplication(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
  opts: { now?: Date } = {},
): Promise<Response> {
  const organizationId = orgId(session);
  const now = opts.now ?? new Date();
  const body = (await request.json().catch(() => ({}))) as { cycleId?: unknown };
  const cycleId = typeof body.cycleId === 'string' ? body.cycleId : '';

  const cycle = await env.DB.prepare(
    `SELECT id, program_id, status, opens_at, closes_at
       FROM cycles WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(cycleId)
    .first<{ id: string; program_id: string; status: string; opens_at: string; closes_at: string }>();

  if (!cycle || !isAcceptingApplications(cycle, now)) throw notFound('application');

  const stages = await env.DB.prepare(
    `SELECT ps.id AS stage_id, ps.stage_key, ps.sort_order, ps.gate_on_prior_decision,
            fd.id AS form_definition_id
       FROM program_stages ps
       JOIN form_definitions fd
         ON fd.stage_id = ps.id AND fd.status = 'published' AND fd.deleted_at IS NULL
      WHERE ps.program_id = ? AND ps.deleted_at IS NULL
      ORDER BY ps.sort_order`,
  )
    .bind(cycle.program_id)
    .all<StageRow>();

  // The first stage the applicant has NOT already submitted. Walking forward
  // rather than jumping to the last one is what makes a three-stage program
  // work without this code knowing how many stages there are.
  let target: StageRow | null = null;
  let priorSatisfied = true;
  for (const stage of stages.results) {
    const existing = await env.DB.prepare(
      `SELECT id, status FROM applications
        WHERE cycle_id = ? AND organization_id = ? AND stage_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
      .bind(cycle.id, organizationId, stage.stage_id)
      .first<{ id: string; status: string }>();

    if (!existing) {
      target = stage;
      break;
    }
    priorSatisfied = (GATE_SATISFYING as readonly string[]).includes(existing.status);
  }

  if (!target) {
    throw new AppError('CONFLICT', 'You have already started every stage of this application.', {
      internalMessage: `no unstarted stage for org ${organizationId} in cycle ${cycle.id}`,
      severity: 'warn',
    });
  }

  if (target.gate_on_prior_decision === 1 && !priorSatisfied) {
    // 403 rather than 404: the applicant knows this stage exists, they were
    // told about it on the eligibility screen. What they do not have is a
    // decision at the stage before it.
    throw new AppError('FORBIDDEN', 'Please complete the previous step first.', {
      internalMessage: `stage ${target.stage_key} gated for org ${organizationId}`,
      severity: 'warn',
    });
  }

  const applicationId = newId();
  const stamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,?)`,
    ).bind(applicationId, cycle.id, target.stage_id, organizationId, target.form_definition_id, stamp, stamp),
    auditStatement(env.DB, ctx, {
      action: 'application.created',
      entityType: 'application',
      entityId: applicationId,
      after: {
        cycle_id: cycle.id,
        stage_id: target.stage_id,
        organization_id: organizationId,
        status: 'draft',
      },
    }),
  ]);

  return json({ application: { id: applicationId, status: 'draft', stage_key: target.stage_key } }, 201);
}

/**
 * GET /api/applications/:id/draft
 *
 * The form definition AND the answers so far, so a different device can
 * resume exactly where the last one stopped.
 */
export async function readDraft(
  env: Env,
  session: Session,
  applicationId: string,
): Promise<Response> {
  const organizationId = orgId(session);

  const app = await env.DB.prepare(
    `SELECT id, status, form_definition_id, updated_at
       FROM applications
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
  )
    .bind(applicationId, organizationId)
    .first<{ id: string; status: string; form_definition_id: string; updated_at: string }>();

  // 404 for another organization's application, exactly as for one that does
  // not exist. A 403 would confirm it is real.
  if (!app) throw notFound('application');

  const definition = await loadFormDefinition(env.DB, app.form_definition_id);
  const answers = await env.DB.prepare(
    `SELECT field_key, value_text, value_int, value_real, value_json
       FROM application_answers WHERE application_id = ?`,
  )
    .bind(app.id)
    .all<{
      field_key: string;
      value_text: string | null;
      value_int: number | null;
      value_real: number | null;
      value_json: string | null;
    }>();

  const byKey = new Map(allFields(definition).map((f) => [f.field_key, f]));
  const values: Record<string, unknown> = {};
  for (const row of answers.results) {
    const field = byKey.get(row.field_key);
    // Defence in depth, and honestly unreachable: form_fields has no deleted_at
    // so a published definition never loses a field, and the database refuses
    // an answer pointing at a different definition's field. Kept for the day
    // either of those changes; asserted as a schema property in the tests
    // rather than pretended to be covered here.
    if (!field) continue;
    values[row.field_key] =
      row.value_json !== null
        ? (JSON.parse(row.value_json) as unknown)
        : row.value_int !== null
          ? row.value_int
          : row.value_real !== null
            ? row.value_real
            : row.value_text;
  }

  return json({
    application: { id: app.id, status: app.status, updated_at: app.updated_at },
    form: definition,
    answers: values,
  });
}

/** PATCH /api/applications/:id/draft — autosave one or more sections. */
export async function autosaveDraft(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
): Promise<Response> {
  orgId(session);
  const body = (await request.json().catch(() => ({}))) as { answers?: unknown };
  const answers =
    typeof body.answers === 'object' && body.answers !== null && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};

  // saveDraft does the scoping, the draft-status guard, the partial validation
  // and the audit. It is the same function the tests have exercised since
  // Phase 0; this route is plumbing, not a second implementation.
  const result = await saveDraft(env.DB, ctx, session, applicationId, answers);
  return json({ savedAt: result.savedAt, errors: result.errors });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * A confirmation code an applicant can read aloud on the phone.
 *
 * The application id is a UUID, which is correct for a URL and useless for a
 * human. This takes the first eight hex characters and groups them, so a
 * program manager searching for "IC-3F9A-21C7" finds the row. It is a display
 * rendering of the id, not a second identifier: nothing is stored, and it is
 * never accepted as input, so there is no uniqueness claim to defend.
 */
export function confirmationCode(applicationId: string): string {
  const hex = applicationId.replace(/-/g, '').toUpperCase();
  return `IC-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

interface SubmitContextRow {
  program_name: string;
  organization_legal_name: string;
  project_title: string | null;
  requested_amount_cents: number | null;
  primary_contact_email: string | null;
  form_definition_id: string;
  decision_due_at: string | null;
}

/**
 * Build and send the confirmation, after the application is already submitted.
 *
 * NEVER THROWS. CLAUDE.md step 10 wants the applicant to hold a record without
 * signing back in, but a mail provider having a bad afternoon must not turn a
 * submitted application into a 500 that makes an applicant submit again.
 * `sendEmail` already returns rather than throws for a provider failure; this
 * wrapper covers the rest -- a missing contact row, a template that cannot
 * render -- and logs instead.
 *
 * The read-back is built from what was PERSISTED, re-read after the write.
 *
 * Exported for its own test. The organization scoping on the read below is
 * redundant with the scoping submitApplication already did, and redundant
 * scoping is exactly the kind of line that gets removed as noise -- so it has
 * a test that fails when it goes.
 */
export async function sendConfirmation(
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  submittedAt: string,
): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT p.name AS program_name,
              o.legal_name AS organization_legal_name,
              a.project_title, a.requested_amount_cents, a.primary_contact_email,
              a.form_definition_id, c.decision_due_at
         FROM applications a
         JOIN cycles c ON c.id = a.cycle_id
         JOIN programs p ON p.id = c.program_id
         JOIN organizations o ON o.id = a.organization_id
        WHERE a.id = ? AND a.organization_id = ?`,
    )
      .bind(applicationId, orgId(session))
      .first<SubmitContextRow>();
    if (!row) return;

    // Where the receipt goes. The address the applicant put ON the form wins
    // over the one they signed in with: a director who signs in as herself and
    // names grants@ as the contact expects grants@ to hold the record.
    const to = row.primary_contact_email ?? session.email;

    const definition = await loadFormDefinition(env.DB, row.form_definition_id);
    const answers = await loadStoredAnswers(env.DB, applicationId);

    await sendEmail(
      env,
      ctx,
      {
        template: APPLICATION_RECEIVED,
        to,
        // One receipt per application, forever. A retry of the same submit
        // cannot produce a second copy in the applicant's inbox.
        idempotencyKey: `application_received:${applicationId}`,
        vars: {
          organizationName: row.organization_legal_name,
          programName: row.program_name,
          projectTitle: row.project_title ?? 'Your application',
          // The display edge. Cents become dollars here and nowhere earlier.
          requestedAmount:
            row.requested_amount_cents === null
              ? 'Not stated'
              : formatCents(row.requested_amount_cents),
          submittedAtDisplay: formatInZone(submittedAt, env.DISPLAY_TIMEZONE),
          confirmationCode: confirmationCode(applicationId),
          ...(row.decision_due_at
            ? {
                decisionByDisplay: formatInZone(row.decision_due_at, env.DISPLAY_TIMEZONE, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: undefined,
                  minute: undefined,
                  timeZoneName: undefined,
                }),
              }
            : {}),
          answers: readBackLines(definition, answers),
        },
        // Entity ids only. The read-back itself is never stored on the message
        // row -- it is the applicant's financial detail, and email_messages is
        // an operational log.
        context: { application_id: applicationId, organization_id: orgId(session) },
      },
      transportFor(env),
    );
  } catch (err) {
    await logError(env, ctx, {
      code: 'CONFIRMATION_EMAIL_FAILED',
      severity: 'error',
      message:
        err instanceof Error
          ? `confirmation email failed after a successful submit: ${err.message}`
          : 'confirmation email failed after a successful submit',
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { application_id: applicationId },
    });
  }
}

/**
 * POST /api/applications/:id/submit
 *
 * `submitApplication` does the scoping, the cycle window, the whole-definition
 * validation, the attachment claim and the atomic write. This route is the
 * plumbing around it plus the receipt.
 *
 * NOT DONE HERE, and it should be said rather than discovered: the marketing
 * opt-in does not sync to Eloqua. CLAUDE.md step 10 puts that on this path,
 * and there is no Eloqua client in the codebase yet. The answer is stored, so
 * nothing is lost -- it is a backfill later, not a re-ask.
 */
export async function submitDraft(
  request: Request,
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
): Promise<Response> {
  orgId(session);
  const body = (await request.json().catch(() => ({}))) as {
    answers?: unknown;
    guidelinesVersion?: unknown;
  };
  const answers =
    typeof body.answers === 'object' && body.answers !== null && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};

  const result = await submitApplication(env.DB, ctx, session, applicationId, answers, {
    guidelinesVersion:
      typeof body.guidelinesVersion === 'string' ? body.guidelinesVersion : undefined,
  });

  // After the write, never before, and never in a way that can fail the submit.
  await sendConfirmation(env, ctx, session, result.applicationId, result.submittedAt);

  /*
   * Formatting is inside a try/catch for the same reason the email is.
   *
   * The application is ALREADY COMMITTED by this point. An invalid
   * DISPLAY_TIMEZONE would throw here and turn a successful submit into a 500,
   * which is how an applicant ends up submitting twice -- the exact failure
   * sendConfirmation is wrapped against, reintroduced one line lower. Caught by
   * a test that already existed for the email, which is the only reason this
   * comment is not an apology.
   */
  let submittedAtDisplay = result.submittedAt;
  try {
    submittedAtDisplay = formatInZone(result.submittedAt, env.DISPLAY_TIMEZONE);
  } catch (err) {
    await logError(env, ctx, {
      code: 'DISPLAY_TIMEZONE_INVALID',
      severity: 'error',
      message: `could not format a submission time: ${err instanceof Error ? err.message : String(err)}`,
      context: { application_id: result.applicationId },
    });
  }

  return json(
    {
      applicationId: result.applicationId,
      submittedAt: result.submittedAt,
      confirmationCode: confirmationCode(result.applicationId),
      // Formatted by the same function the confirmation email uses, so the
      // screen and the email cannot disagree about when this happened. The
      // browser was formatting the ISO string in its own zone with no zone
      // name on it, which for an applicant two zones away is a different time.
      submittedAtDisplay,
    },
    200,
  );
}
