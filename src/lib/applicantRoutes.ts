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
import { saveDraft } from './submit';
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
