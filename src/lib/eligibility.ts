/**
 * The eligibility screen: the only route that creates an applicant.
 *
 * Everything before this point serves accounts that already exist. This is
 * where a nonprofit that has never applied becomes an organization, a contact
 * and a user -- and where an ineligible one is told so before writing a word
 * of narrative.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *
 *   1. Turnstile and rate limits, before anything is read or written.
 *   2. The cycle must actually be open. A closed cycle is checked against the
 *      SERVER clock and the stored timestamps, never against anything the
 *      browser sent.
 *   3. The whole form is validated server-side. The client validates the same
 *      definition, but a client is a convenience and not a gate.
 *   4. Identity is resolved, which may refuse.
 *   5. The application row and its answers are written in ONE batch.
 *   6. A sign-in link goes out.
 *
 * Steps 4 and 5 are separate batches because identity resolution is idempotent
 * -- if the process dies between them the applicant resubmits and lands on the
 * same organization, contact and user rather than a duplicate set.
 */

import type { Env, RequestContext } from '../types';
import { AppError, validationFailed } from './errors';
import { newId } from './ids';
import { nowIso, formatInZone } from './time';
import { auditStatement } from './audit';
import { allFields, validateSubmission } from './forms';
import { loadFormDefinition } from './loadForm';
import { promote } from './mapsTo';
import { answerStatements } from './submit';
import { resolveApplicantIdentity } from './identity';
import { issueLoginToken, TOKEN_TTL_MS } from './tokens';
import { sendEmail, transportFor } from './email';
import { SIGN_IN_LINK } from './emailTemplates';
import { checkRateLimit, SIGN_IN_EMAIL_LIMIT, SIGN_IN_IP_LIMIT } from './rateLimit';
import { verifyTurnstile } from './turnstile';

interface CycleRow {
  id: string;
  program_id: string;
  status: string;
  opens_at: string;
  closes_at: string;
}

export interface EligibilityBody {
  cycleId?: unknown;
  answers?: unknown;
  turnstileToken?: unknown;
}

export async function submitEligibility(
  request: Request,
  env: Env,
  ctx: RequestContext,
  opts: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<Response> {
  const now = opts.now ?? new Date();
  const body = (await request.json().catch(() => ({}))) as EligibilityBody;

  const turnstile = await verifyTurnstile(
    env,
    typeof body.turnstileToken === 'string' ? body.turnstileToken : null,
    ctx.ip,
    opts.fetcher,
  );
  if (!turnstile.ok) {
    throw new AppError('FORBIDDEN', 'We could not verify that you are a person. Please try again.', {
      internalMessage: `turnstile ${turnstile.reason}`,
      severity: 'warn',
    });
  }

  const byIp = await checkRateLimit(env, SIGN_IN_IP_LIMIT, ctx.ip ?? 'unknown');
  if (!byIp.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a few minutes.', {
      internalMessage: 'eligibility ip rate limit',
      severity: 'warn',
    });
  }

  const cycleId = typeof body.cycleId === 'string' ? body.cycleId : '';
  const answers = isRecord(body.answers) ? body.answers : {};

  const cycle = await env.DB.prepare(
    `SELECT id, program_id, status, opens_at, closes_at
       FROM cycles WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(cycleId)
    .first<CycleRow>();

  // 404 rather than 400 for a cycle that is not open: an unauthenticated
  // caller learns nothing about which cycles exist in what state.
  if (!cycle || !isAcceptingApplications(cycle, now)) {
    throw new AppError('NOT_FOUND', 'That application is not open.', {
      internalMessage: cycle ? `cycle ${cycleId} not open (${cycle.status})` : `no cycle ${cycleId}`,
      severity: 'warn',
    });
  }

  // The FIRST stage of the program, by sort order, and only a PUBLISHED form.
  // Serving a draft definition to the public would let an unfinished form
  // collect real answers.
  const form = await env.DB.prepare(
    `SELECT fd.id
       FROM form_definitions fd
       JOIN program_stages ps ON ps.id = fd.stage_id
      WHERE fd.program_id = ? AND fd.status = 'published' AND fd.deleted_at IS NULL
        AND ps.deleted_at IS NULL AND ps.gate_on_prior_decision = 0
      ORDER BY ps.sort_order
      LIMIT 1`,
  )
    .bind(cycle.program_id)
    .first<{ id: string }>();

  if (!form) {
    throw new AppError('NOT_FOUND', 'That application is not open.', {
      internalMessage: `no published ungated stage for program ${cycle.program_id}`,
      severity: 'error',
    });
  }

  const definition = await loadFormDefinition(env.DB, form.id);
  const outcome = validateSubmission(definition, answers);
  if (outcome.errors.length > 0) throw validationFailed(outcome.errors);

  const fields = allFields(definition);
  const promoted = promote(fields, outcome.answers);

  const email = String(promoted.application.primary_contact_email ?? '').trim().toLowerCase();
  const ein = String(promoted.organization.ein ?? '');
  const legalName = String(promoted.organization.legal_name ?? '').trim();
  if (!email || !ein || !legalName) {
    // Only reachable if a program published an eligibility form without the
    // promotion targets, which the coverage gate refuses. Fail loudly rather
    // than creating a nameless organization.
    throw new AppError('VALIDATION_FAILED', 'This form is not configured correctly.', {
      internalMessage: `eligibility form ${form.id} did not promote name, ein and email`,
      severity: 'error',
    });
  }

  const byEmail = await checkRateLimit(env, SIGN_IN_EMAIL_LIMIT, email);
  if (!byEmail.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a few minutes.', {
      internalMessage: 'eligibility email rate limit',
      severity: 'warn',
    });
  }

  const identity = await resolveApplicantIdentity(env.DB, ctx, {
    ein,
    legalName,
    email,
    firstName: String(promoted.contact.first_name ?? ''),
    lastName: String(promoted.contact.last_name ?? ''),
  });

  if (identity.kind !== 'ready') return identityProblem(identity.kind);

  // --- has this organization already passed eligibility for this cycle? -----
  //
  // Submitting twice is an ORDINARY thing to do: the email did not arrive, or
  // arrived late, or went to a colleague. The per-cycle application limit is a
  // database constraint, so without this the second attempt was a 500 -- an
  // internal error shown to somebody doing something entirely reasonable.
  //
  // The right answer is to be idempotent: keep the application they already
  // have, and send another link.
  const already = await env.DB.prepare(
    `SELECT a.id FROM applications a
       JOIN form_definitions fd ON fd.id = a.form_definition_id
      WHERE a.cycle_id = ? AND a.organization_id = ? AND fd.id = ?
        AND a.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(cycle.id, identity.organizationId, form.id)
    .first<{ id: string }>();

  if (already) {
    await sendSignInLink(env, ctx, {
      userId: identity.userId,
      email,
      applicationId: already.id,
      stamp: nowIso(),
    });
    return accepted(email, 'again');
  }

  // --- the application row, its answers, and the audit, in one batch --------
  const applicationId = newId();
  const stamp = nowIso();
  // The version of the guidelines this applicant attested to, pinned on the
  // row rather than looked up later -- the document moves and the attestation
  // does not.
  const guidelinesVersion = (
    await env.DB.prepare(`SELECT guidelines_version FROM programs WHERE id = ?`)
      .bind(cycle.program_id)
      .first<{ guidelines_version: string | null }>()
  )?.guidelines_version ?? null;
  const statements = [
    env.DB.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         submitted_by_contact_id, status, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, ?, 'draft', ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    ).bind(applicationId, cycle.id, identity.organizationId, identity.contactId, stamp, stamp, form.id),

    // Written while the row is still 'draft', because answerStatements guards
    // on that -- the same guard the autosave path relies on. The flip to
    // 'submitted' is the last statement in the batch.
    ...answerStatements(env.DB, applicationId, definition, outcome.answers, stamp),

    // Promotion is the whole point of maps_to: without it the answers exist
    // only in application_answers, and every cross-program report has to parse
    // that table forever. The first version of this route flipped the status
    // and wrote no promoted column at all.
    env.DB.prepare(
      `UPDATE applications
          SET status = 'submitted', submitted_at = ?, updated_at = ?,
              submission_ip = ?, submission_user_agent = ?,
              requested_amount_cents = ?,
              organization_name_at_submit = ?,
              ein_at_submit = ?,
              primary_contact_email = ?,
              counties_served_json = ?,
              guidelines_version = ?
        WHERE id = ? AND status = 'draft'`,
    ).bind(
      stamp,
      stamp,
      ctx.ip,
      ctx.userAgent,
      promoted.application.requested_amount_cents ?? null,
      promoted.application.organization_name_at_submit ?? legalName,
      promoted.application.ein_at_submit ?? ein,
      promoted.application.primary_contact_email ?? email,
      promoted.application.counties_served_json ?? null,
      guidelinesVersion,
      applicationId,
    ),

    auditStatement(env.DB, ctx, {
      action: 'application.submitted',
      entityType: 'application',
      entityId: applicationId,
      after: {
        cycle_id: cycle.id,
        organization_id: identity.organizationId,
        stage: 'eligibility',
        status: 'submitted',
      },
    }),
  ];
  await env.DB.batch(statements);

  // --- and the link --------------------------------------------------------
  await sendSignInLink(env, ctx, { userId: identity.userId, email, applicationId, stamp });
  return accepted(email, 'new');
}

async function sendSignInLink(
  env: Env,
  ctx: RequestContext,
  o: { userId: string; email: string; applicationId: string; stamp: string },
): Promise<void> {
  const issued = await issueLoginToken(env.DB, ctx, { userId: o.userId, email: o.email });
  const base = (env.APPLICANT_BASE_URL ?? '').replace(/\/+$/, '');
  await sendEmail(
    env,
    ctx,
    {
      template: SIGN_IN_LINK,
      to: o.email,
      idempotencyKey: `sign_in_link:${issued.tokenId}`,
      vars: {
        url: `${base}/auth/verify?token=${encodeURIComponent(issued.token)}`,
        expiresInMinutes: Math.round(TOKEN_TTL_MS / 60000),
        destination: 'Inspire Change application',
        requestedAtDisplay: formatInZone(o.stamp, env.DISPLAY_TIMEZONE),
        requestAnotherUrl: `${base}/sign-in`,
      },
      context: { user_id: o.userId, application_id: o.applicationId },
    },
    transportFor(env),
  );
}

function accepted(email: string, kind: 'new' | 'again'): Response {
  return new Response(
    JSON.stringify({
      // The applicant just typed this address, so saying we sent it there
      // reveals nothing they do not already know -- unlike the
      // request-a-link endpoint, where the address is a guess.
      message:
        kind === 'again'
          ? 'You have already completed this step. We have sent a fresh sign-in link to your email address; it expires in 15 minutes.'
          : 'You are eligible to apply. We have sent a sign-in link to your email address; it expires in 15 minutes.',
      email,
    }),
    { status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

/**
 * A cycle accepts applications only when its status says so AND the clock
 * agrees. Both, because a status left on 'open' past its close date is the
 * likelier operational mistake and the one an applicant would exploit by
 * accident rather than on purpose.
 */
export function isAcceptingApplications(
  cycle: Pick<CycleRow, 'status' | 'opens_at' | 'closes_at'>,
  now: Date,
): boolean {
  if (cycle.status !== 'open') return false;
  const opens = Date.parse(cycle.opens_at);
  const closes = Date.parse(cycle.closes_at);
  if (Number.isNaN(opens) || Number.isNaN(closes)) return false;
  const t = now.getTime();
  return t >= opens && t < closes;
}

function identityProblem(kind: string): Response {
  // Each of these is a human-shaped problem, so each gets a human-shaped
  // sentence and a way forward. None of them says anything about another
  // organization beyond what the applicant already typed.
  const messages: Record<string, string> = {
    ambiguous_organization:
      'We have more than one record for that EIN and cannot tell which is yours. Please email grants@houstontexansfoundation.org and we will sort it out.',
    email_belongs_to_other_organization:
      'That email address is already registered to a different organization. Please use an address for this organization, or email grants@houstontexansfoundation.org.',
    email_belongs_to_staff:
      'That email address cannot be used to apply. Please use an address belonging to your organization.',
    invalid_ein: 'That EIN does not look right. It should be nine digits, for example 76-1234567.',
  };
  return new Response(
    JSON.stringify({
      error: { code: 'IDENTITY_CONFLICT', message: messages[kind] ?? messages.invalid_ein },
    }),
    { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
