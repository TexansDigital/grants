/**
 * Turning a verified Access assertion into a Session.
 *
 * THE DECISION THAT MATTERS HERE: an email that Access authenticates is NOT
 * automatically a staff account.
 *
 * Access answers "is this a person our policy admits?". It does not answer
 * "should this person see other nonprofits' audited financial statements?".
 * Auto-provisioning a user row on first sign-in would collapse those two
 * questions into one, and would mean widening an Access policy silently grants
 * access to every application in the system. So the user row must already
 * exist, be active, and carry an internal role.
 *
 * The cost is that adding a staff member is two steps: the Access policy, and
 * a user row. That is the correct amount of friction for this decision.
 */

import type { Env, RequestContext, Role, Session } from '../types';
import { AppError, notFound } from './errors';
import { verifyAccessJwt, extractAccessToken, type JwksFetcher } from './access';
import { auditStatement } from './audit';
import { nowIso } from './time';

/** Roles that sign in through Cloudflare Access. */
const ACCESS_ROLES: Role[] = ['admin', 'reviewer', 'executive'];

interface UserRow {
  id: string;
  email: string;
  role: Role;
  organization_id: string | null;
  is_active: number;
  last_login_at: string | null;
}

/**
 * Resolve the staff session for a request, or throw.
 *
 * Returns a Session only when: Access verified the assertion, a live user row
 * exists for that exact email, and the role is one that signs in via Access.
 */
export async function requireStaffSession(
  request: Request,
  env: Env,
  ctx: RequestContext,
  opts: { fetchJwks?: JwksFetcher; now?: number } = {},
): Promise<Session> {
  const token = extractAccessToken(request);
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.', {
      internalMessage: 'no Cf-Access-Jwt-Assertion header or CF_Authorization cookie',
      severity: 'warn',
    });
  }

  const claims = await verifyAccessJwt(
    token,
    { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD },
    opts,
  );

  const user = await env.DB.prepare(
    `SELECT id, email, role, organization_id, is_active, last_login_at
       FROM users
      WHERE email = ? AND deleted_at IS NULL`,
  )
    .bind(claims.email)
    .first<UserRow>();

  // Every rejection below is the same 404 to the client. Distinguishing "you
  // have no account" from "your account is disabled" from "you are an
  // applicant, not staff" tells an attacker which emails are staff.
  if (!user) {
    throw notFound('account');
  }
  if (user.is_active !== 1) {
    throw notFound('account');
  }
  if (!ACCESS_ROLES.includes(user.role)) {
    // An applicant or grantee whose email also passes the Access policy. They
    // sign in by magic link, not Access, and must not get a staff session.
    throw notFound('account');
  }

  const session: Session = {
    userId: user.id,
    email: user.email,
    role: user.role,
    // The users CHECK constraint already guarantees this is null for internal
    // roles; asserting it here means a future schema change cannot quietly
    // hand a staff session an organization scope.
    organizationId: null,
  };

  /*
   * Record the sign-in, at most once an hour per person.
   *
   * There is no login EVENT to hook: Cloudflare Access authenticates every
   * request, so the Worker never sees a moment that is uniquely "signing in".
   * recordLogin was written for that moment, and consequently was never called
   * from anywhere -- which left no record at all of who had accessed a system
   * holding other organizations' EINs and audited financial statements.
   *
   * Writing on every request is the obvious wrong answer: it turns every read
   * into a write on a single-writer database. Staleness is the compromise. An
   * hour is short enough that "who was in the system on Tuesday" is answerable
   * and long enough that a busy admin costs one extra write per hour.
   */
  if (isLoginStale(user.last_login_at, opts?.now)) {
    await recordLogin(env, ctx, session);
  }

  return session;
}

/** One hour. Long enough to be cheap, short enough to be useful evidence. */
const LOGIN_RECORD_INTERVAL_MS = 60 * 60 * 1000;

export function isLoginStale(lastLoginAt: string | null | undefined, now?: number): boolean {
  if (!lastLoginAt) return true;
  const previous = Date.parse(lastLoginAt);
  // A malformed timestamp is treated as stale: recording an extra sign-in is
  // harmless, and skipping one because a date could not be parsed is not.
  if (!Number.isFinite(previous)) return true;
  return (now ?? Date.now()) - previous >= LOGIN_RECORD_INTERVAL_MS;
}

/**
 * Record a sign-in.
 *
 * Separate from resolution so a read-only request is not a write. Called once
 * per session establishment, not per request.
 */
export async function recordLogin(env: Env, ctx: RequestContext, session: Session): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(
      now,
      now,
      session.userId,
    ),
    auditStatement(env.DB, { ...ctx, session }, {
      action: 'auth.logged_in',
      entityType: 'user',
      entityId: session.userId,
      after: { role: session.role, last_login_at: now },
    }),
  ]);
}
