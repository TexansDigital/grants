/**
 * "You funded us. Here is what we did with it."
 *
 * WHY A CLAIM AND NOT A SIGN-UP. Access to an award is access to another
 * organization's grant history: what they asked for, what they got, what they
 * have reported and what they still owe. A form that hands that to whoever
 * types the right organization name is the worst thing this system could
 * offer, and EIN matching does not fix it -- an EIN is printed on every Form
 * 990 and is not a secret.
 *
 * So the public half of this file records a REQUEST and grants nothing. The
 * staff half grants, and only a person can call it.
 *
 * WHY THE PUBLIC ENDPOINT IS DELIBERATELY UNINFORMATIVE. It answers
 * identically whether or not a matching award exists, exactly like the
 * eligibility screen. Anything else turns it into an oracle: feed it EINs and
 * learn which nonprofits the Foundation has funded, one request at a time.
 * That list is the Foundation's to publish, and there is already a page that
 * publishes the part of it they have chosen to.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { auditStatement, writeAudit } from './audit';
import { newId } from './ids';
import { nowIso } from './time';
import { normalizeEin } from './ein';
import { verifyTurnstile } from './turnstile';
import { checkRateLimit, SIGN_IN_EMAIL_LIMIT, SIGN_IN_IP_LIMIT } from './rateLimit';
import { generateReportPeriods } from './reportPeriods';
import { sendEmail, transportFor, type EmailTransport } from './email';
import { GRANTEE_CLAIM_RECEIVED, GRANTEE_CLAIM_APPROVED } from './emailTemplates';

export interface ClaimInput {
  organizationName: string;
  ein: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  grantYear: number | null;
  grantDescription: string | null;
}

function text(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function optional(v: unknown, max = 200): string | null {
  const t = text(v, max);
  return t === '' ? null : t;
}

/**
 * Read a claim off the wire.
 *
 * Length caps on everything, because this is a public endpoint that writes
 * rows and the only thing standing between it and a megabyte of prose in a
 * name field is this function.
 */
export function readClaim(body: Record<string, unknown>): ClaimInput | { error: string } {
  const organizationName = text(body.organizationName);
  const firstName = text(body.firstName, 100);
  const lastName = text(body.lastName, 100);
  const email = text(body.email, 255).toLowerCase();

  if (organizationName === '') return { error: 'Please tell us your organization’s name.' };
  if (firstName === '' || lastName === '') return { error: 'Please tell us your name.' };
  // Deliberately loose. A regex that rejects a valid address is worse than one
  // that admits an invalid one: the invalid one bounces, the valid one loses
  // a grantee who cannot report.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'Please check the email address.' };
  }

  const year = Number(body.grantYear);
  return {
    organizationName,
    // An EIN that does not parse is dropped rather than refused: the claim is
    // still useful to a human, and a nine-digit CHECK on the column means a
    // half-typed one cannot be stored as if it were real.
    ein: normalizeEin(body.ein),
    firstName,
    lastName,
    email,
    phone: optional(body.phone, 40),
    jobTitle: optional(body.jobTitle, 120),
    grantYear: Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null,
    grantDescription: optional(body.grantDescription, 2000),
  };
}

/**
 * What the system thinks the claim refers to. ADVISORY, and never acted on.
 *
 * Matching on EIN alone, and only on an exact normalized match. A fuzzy name
 * match would be more helpful to a reviewer and would also be the thing a
 * reviewer trusts on a busy afternoon, so it is deliberately absent: the
 * reviewer picks the award, and this only saves them a search.
 */
async function guess(
  db: D1Database,
  input: ClaimInput,
): Promise<{ organizationId: string | null; awardId: string | null }> {
  if (!input.ein) return { organizationId: null, awardId: null };
  const org = await db
    .prepare(`SELECT id FROM organizations WHERE ein = ? AND deleted_at IS NULL LIMIT 1`)
    .bind(input.ein)
    .first<{ id: string }>();
  if (!org) return { organizationId: null, awardId: null };
  const award = await db
    .prepare(
      `SELECT id FROM awards
        WHERE organization_id = ? AND deleted_at IS NULL AND status <> 'cancelled'
        ORDER BY awarded_at DESC LIMIT 1`,
    )
    .bind(org.id)
    .first<{ id: string }>();
  return { organizationId: org.id, awardId: award?.id ?? null };
}

/** The answer, whatever happened. See the header: this is not an oracle. */
const ACKNOWLEDGEMENT = {
  ok: true,
  message:
    'Thank you. We have your details and someone from the Foundation will be in touch. ' +
    'If we can match you to a grant, you will get an email with a way to sign in.',
} as const;

/**
 * POST /api/public/grantee-claim
 *
 * Turnstile and rate limits BEFORE anything is read or written, in that
 * order, and on the IP even when the body is malformed -- otherwise the
 * cheapest request to make is the one that probes.
 */
export async function submitClaim(
  request: Request,
  env: Env,
  ctx: RequestContext,
  opts: { fetcher?: typeof fetch; transport?: EmailTransport | null } = {},
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

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
      internalMessage: 'grantee claim ip rate limit',
      severity: 'warn',
    });
  }

  const parsed = readClaim(body);
  if ('error' in parsed) {
    throw new AppError('VALIDATION_FAILED', parsed.error, {
      internalMessage: 'grantee claim failed field validation',
      severity: 'warn',
    });
  }

  const byEmail = await checkRateLimit(env, SIGN_IN_EMAIL_LIMIT, parsed.email);
  if (!byEmail.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a few minutes.', {
      internalMessage: 'grantee claim email rate limit',
      severity: 'warn',
    });
  }

  /*
   * A SECOND PENDING CLAIM IS NOT AN ERROR THEY SHOULD SEE.
   *
   * The unique index refuses it, and the honest answer to "I filled this in
   * twice" is the same acknowledgement as the first time. Telling them "you
   * already have a claim" would also tell anybody who guesses an address that
   * somebody at it has claimed a grant.
   */
  const existing = await env.DB.prepare(
    `SELECT id FROM grantee_claims
      WHERE contact_email = ? AND status = 'pending' AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(parsed.email)
    .first<{ id: string }>();
  if (existing) return json(ACKNOWLEDGEMENT);

  const matched = await guess(env.DB, parsed);
  const id = newId();
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO grantee_claims
         (id, organization_name, ein, contact_first_name, contact_last_name, contact_email,
          contact_phone, contact_job_title, grant_year, grant_description,
          matched_organization_id, matched_award_id, status,
          submission_ip, submission_user_agent, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?,?,?,?)`,
    ).bind(
      id, parsed.organizationName, parsed.ein, parsed.firstName, parsed.lastName, parsed.email,
      parsed.phone, parsed.jobTitle, parsed.grantYear, parsed.grantDescription,
      matched.organizationId, matched.awardId,
      ctx.ip, ctx.userAgent, now, now,
    ),
    auditStatement(env.DB, ctx, {
      action: 'grantee_claim.created',
      entityType: 'grantee_claim',
      entityId: id,
      after: {
        organization_name: parsed.organizationName,
        // Whether the system found a match is recorded; WHAT it matched is on
        // the row. An audit line is read by more people than need an award id.
        matched: matched.awardId !== null,
      },
    }),
  ]);

  await sendEmail(
    env,
    ctx,
    {
      template: GRANTEE_CLAIM_RECEIVED,
      to: parsed.email,
      idempotencyKey: `grantee_claim_received:${id}`,
      vars: { organizationName: parsed.organizationName },
    },
    opts.transport === undefined ? transportFor(env) : opts.transport,
  );

  return json(ACKNOWLEDGEMENT);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface ClaimRow {
  id: string;
  organizationName: string;
  ein: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  contactJobTitle: string | null;
  grantYear: number | null;
  grantDescription: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  /** What the system suggested. Advisory; the reviewer chooses. */
  matchedOrganizationName: string | null;
  matchedAwardId: string | null;
  matchedAwardLabel: string | null;
  grantedAwardId: string | null;
}

/** GET /api/grantee-claims — the queue, pending first, oldest first within it. */
export async function listClaims(db: D1Database, status?: string): Promise<ClaimRow[]> {
  const where = status ? `WHERE gc.status = ? AND gc.deleted_at IS NULL` : `WHERE gc.deleted_at IS NULL`;
  const stmt = db.prepare(
    `SELECT gc.*, o.legal_name AS matched_org_name,
            w.awarded_amount_cents AS matched_amount, w.awarded_at AS matched_awarded_at,
            p.name AS matched_program
       FROM grantee_claims gc
       LEFT JOIN organizations o ON o.id = gc.matched_organization_id
       LEFT JOIN awards w       ON w.id = gc.matched_award_id
       LEFT JOIN programs p     ON p.id = w.program_id
       ${where}
      ORDER BY CASE gc.status WHEN 'pending' THEN 0 ELSE 1 END, gc.created_at`,
  );
  const { results } = await (status ? stmt.bind(status) : stmt).all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    organizationName: String(r.organization_name),
    ein: r.ein === null ? null : String(r.ein),
    contactName: `${String(r.contact_first_name)} ${String(r.contact_last_name)}`.trim(),
    contactEmail: String(r.contact_email),
    contactPhone: r.contact_phone === null ? null : String(r.contact_phone),
    contactJobTitle: r.contact_job_title === null ? null : String(r.contact_job_title),
    grantYear: r.grant_year === null ? null : Number(r.grant_year),
    grantDescription: r.grant_description === null ? null : String(r.grant_description),
    status: String(r.status),
    createdAt: String(r.created_at),
    decidedAt: r.decided_at === null ? null : String(r.decided_at),
    decisionNote: r.decision_note === null ? null : String(r.decision_note),
    matchedOrganizationName: r.matched_org_name === null ? null : String(r.matched_org_name),
    matchedAwardId: r.matched_award_id === null ? null : String(r.matched_award_id),
    matchedAwardLabel:
      r.matched_award_id === null
        ? null
        : `${String(r.matched_program ?? 'Grant')} — ${String(r.matched_awarded_at ?? '').slice(0, 4)}`,
    grantedAwardId: r.granted_award_id === null ? null : String(r.granted_award_id),
  }));
}

/**
 * Approve a claim: connect this person to this award.
 *
 * THIS IS THE FUNCTION THAT GRANTS ACCESS, and everything else in this file
 * exists so that it is the only one. It takes the award id from the REVIEWER,
 * never from the claim: `matched_award_id` is what the system guessed from an
 * EIN printed on a public tax filing, and acting on it would make the guess
 * the decision.
 *
 * What it does, in one batch:
 *   - checks the claim is still pending, and the award real
 *   - attaches, or creates, a user at the award's organization
 *   - marks the claim approved and records what it granted
 *
 * Report periods and the email come after, outside the batch, because neither
 * is something to roll the grant back for: a grantee who has access but no
 * period yet is recoverable by a second click, and one whose email bounced can
 * be told by phone.
 */
export async function approveClaim(
  env: Env,
  ctx: RequestContext,
  session: Session,
  claimId: string,
  input: { awardId: string; note?: string | null },
  opts: { transport?: EmailTransport | null } = {},
): Promise<{ claimId: string; userId: string; awardId: string; periodsCreated: number }> {
  const db = env.DB;
  const claim = await db
    .prepare(
      `SELECT id, status, contact_email, contact_first_name, contact_last_name,
              organization_name
         FROM grantee_claims WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(claimId)
    .first<{
      id: string; status: string; contact_email: string;
      contact_first_name: string; contact_last_name: string; organization_name: string;
    }>();
  if (!claim) throw notFound('claim');
  if (claim.status !== 'pending') {
    throw new AppError('CONFLICT', 'That claim has already been decided.', {
      internalMessage: `claim ${claimId} is ${claim.status}`,
      severity: 'warn',
    });
  }

  const award = await db
    .prepare(
      `SELECT w.id, w.organization_id, w.status, o.legal_name
         FROM awards w JOIN organizations o ON o.id = w.organization_id
        WHERE w.id = ? AND w.deleted_at IS NULL AND o.deleted_at IS NULL`,
    )
    .bind(input.awardId)
    .first<{ id: string; organization_id: string; status: string; legal_name: string }>();
  if (!award) throw notFound('award');
  if (award.status === 'cancelled') {
    throw new AppError('CONFLICT', 'That award was cancelled. Pick another, or decline the claim.', {
      internalMessage: `award ${input.awardId} is cancelled`,
      severity: 'warn',
    });
  }

  /*
   * AN EXISTING USER AT A DIFFERENT ORGANIZATION IS A STOP, NOT A MERGE.
   *
   * One address cannot hold two organizations here -- users.organization_id is
   * singular -- so "approve" would have to either move them, silently
   * detaching them from the first organization's data, or duplicate the row
   * and fail the unique index. Both are worse than refusing and telling a
   * human, who can see something this function cannot: whether this is one
   * person who genuinely works for both, or two organizations that share a
   * contractor's email address.
   */
  const user = await db
    .prepare(`SELECT id, organization_id, is_active FROM users WHERE email = ? AND deleted_at IS NULL`)
    .bind(claim.contact_email)
    .first<{ id: string; organization_id: string | null; is_active: number }>();

  if (user && user.organization_id && user.organization_id !== award.organization_id) {
    throw new AppError(
      'CONFLICT',
      `${claim.contact_email} is already attached to a different organization. ` +
        'Sort that out before approving this claim.',
      {
        internalMessage: `claim ${claimId}: user org ${user.organization_id} != award org ${award.organization_id}`,
        severity: 'warn',
      },
    );
  }

  const now = nowIso();
  const userId = user?.id ?? newId();
  const statements = [];

  if (!user) {
    statements.push(
      db.prepare(
        `INSERT INTO users (id, email, role, organization_id, display_name, is_active,
           created_at, updated_at)
         VALUES (?,?, 'grantee', ?, ?, 1, ?, ?)`,
      ).bind(
        userId, claim.contact_email, award.organization_id,
        `${claim.contact_first_name} ${claim.contact_last_name}`.trim() || null, now, now,
      ),
      auditStatement(db, ctx, {
        action: 'user.created',
        entityType: 'user',
        entityId: userId,
        after: { email: claim.contact_email, role: 'grantee', organization_id: award.organization_id, source: 'grantee_claim' },
      }),
    );
  } else if (user.is_active === 0) {
    // Reactivating is a real change and is audited as one. A deactivated
    // account silently coming back is exactly the kind of thing somebody
    // should be able to find afterwards.
    statements.push(
      db.prepare(`UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?`).bind(now, userId),
      auditStatement(db, ctx, {
        action: 'user.reactivated',
        entityType: 'user',
        entityId: userId,
        before: { is_active: 0 },
        after: { is_active: 1, source: 'grantee_claim' },
      }),
    );
  }

  statements.push(
    db.prepare(
      `UPDATE grantee_claims
          SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ?,
              granted_user_id = ?, granted_award_id = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(now, session.userId, input.note ?? null, userId, award.id, now, claimId),
    auditStatement(db, ctx, {
      action: 'grantee_claim.approved',
      entityType: 'grantee_claim',
      entityId: claimId,
      before: { status: 'pending' },
      after: {
        status: 'approved',
        granted_user_id: userId,
        granted_award_id: award.id,
        organization_id: award.organization_id,
      },
    }),
  );

  const results = await db.batch(statements);
  // The UPDATE is the last statement and its guard is the pending check, so a
  // second reviewer approving the same claim at the same moment changes
  // nothing and is told so rather than granting twice.
  const changed = results[results.length - 2]?.meta?.changes ?? 0;
  if (changed === 0) {
    throw new AppError('CONFLICT', 'That claim has already been decided.', {
      internalMessage: `claim ${claimId} lost the race`,
      severity: 'warn',
    });
  }

  /*
   * PERIODS AFTER THE GRANT, and tolerantly. An award imported from a
   * spreadsheet may have no term dates, in which case there is nothing to
   * generate from -- which is a gap for staff to fill, not a reason to refuse
   * somebody access to the award they were just connected to.
   */
  let periodsCreated = 0;
  try {
    const gen = await generateReportPeriods(db, ctx, award.id);
    periodsCreated = gen.created ?? 0;
  } catch {
    periodsCreated = 0;
  }

  const base = (env.APPLICANT_BASE_URL ?? '').replace(/\/+$/, '');
  await sendEmail(
    env,
    ctx,
    {
      template: GRANTEE_CLAIM_APPROVED,
      to: claim.contact_email,
      idempotencyKey: `grantee_claim_approved:${claimId}`,
      vars: {
        organizationName: award.legal_name,
        email: claim.contact_email,
        signInUrl: `${base}/sign-in`,
        whatIsDue:
          periodsCreated > 0
            ? 'There is a report waiting for you, and the portal will show you what it asks for.'
            : null,
      },
    },
    opts.transport === undefined ? transportFor(env) : opts.transport,
  );

  return { claimId, userId, awardId: award.id, periodsCreated };
}

/**
 * Decline a claim, with a reason.
 *
 * NO EMAIL. A claim is often somebody misremembering which funder gave them a
 * grant, and "we have no record of funding you" is a sentence that should come
 * from a person who can say it kindly and answer the next question, not from
 * an automated message at two in the morning. CLAUDE.md already holds this
 * line for decline letters; the same reasoning applies here.
 *
 * The reason is required, and is for the Foundation: it is what the next
 * person reads when the same organization claims again.
 */
export async function rejectClaim(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  claimId: string,
  note: string,
): Promise<{ claimId: string }> {
  const reason = note.trim();
  if (reason === '') {
    throw new AppError('VALIDATION_FAILED', 'Say why, so the next person reading this knows.', {
      internalMessage: 'reject with no reason',
      severity: 'warn',
    });
  }

  const now = nowIso();
  const results = await db.batch([
    db.prepare(
      `UPDATE grantee_claims
          SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
    ).bind(now, session.userId, reason, now, claimId),
    auditStatement(db, ctx, {
      action: 'grantee_claim.rejected',
      entityType: 'grantee_claim',
      entityId: claimId,
      before: { status: 'pending' },
      after: { status: 'rejected', reason },
    }, {
      // Conditional on the same predicate as the UPDATE beside it. Without
      // this, a second reviewer rejecting the same claim writes an audit row
      // asserting a decision that changed nothing.
      guard: {
        sql: `EXISTS (SELECT 1 FROM grantee_claims WHERE id = ? AND status = 'rejected')`,
        binds: [claimId],
      },
    }),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new AppError('CONFLICT', 'That claim has already been decided, or does not exist.', {
      internalMessage: `claim ${claimId} not pending`,
      severity: 'warn',
    });
  }
  return { claimId };
}
