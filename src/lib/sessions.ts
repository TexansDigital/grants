/**
 * Applicant and grantee sessions.
 *
 * Staff sign in through Cloudflare Access and never reach this file; Access is
 * capped at 50 seats and applicants would exhaust it. See lib/auth.ts.
 *
 * THE SHAPE, AND WHY:
 *
 * The session record lives in KV, as CLAUDE.md says. KV's weakness for this
 * job is that deletes are eventually consistent, so pressing "sign out" does
 * not reliably end a session at the moment it is pressed -- which is exactly
 * when it matters, on a shared computer in a nonprofit office.
 *
 * Rather than move sessions to D1, every session carries the time it was
 * issued and every lookup compares that against `users.sessions_valid_from`.
 * Signing out sets that column to now, which kills every session issued before
 * now, immediately, with no dependence on KV propagation. "Sign out
 * everywhere" and an admin revoking access are then the same operation.
 *
 * The KV delete still happens -- it is what stops the record lingering for
 * days -- but correctness does not depend on when it lands.
 *
 * Every lookup also re-reads the user row, so role, organization and
 * `is_active` are the CURRENT values rather than whatever they were at
 * sign-in. A deactivated account loses access on its next request, not when
 * its session happens to expire.
 */

import type { Env, RequestContext, Role, Session } from '../types';
import { hashToken } from './tokens';

/**
 * Absolute session lifetime.
 *
 * Seven days, not sliding. An applicant mid-application who is signed out
 * requests another link, which is a fifteen-second interruption; a session
 * that renews itself forever on a shared machine is a different kind of
 * problem. Drafts survive independently of the session, so nothing is lost.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Roles that sign in through a magic link rather than through Access. */
const EXTERNAL_ROLES: readonly Role[] = ['applicant', 'grantee'];

/**
 * May this role hold a magic-link session?
 *
 * Staff never sign in this way: if an admin's user id ever appeared in a
 * session record, honouring it would be a path around Cloudflare Access
 * entirely. Executives have no in-app access at all.
 *
 * Extracted as a predicate because the users CHECK currently makes staff
 * unreachable here by a second route -- every staff role has a null
 * organization_id, which the next guard rejects. That makes this defence in
 * depth whose failure cannot be observed through resolveSession, so it is
 * tested directly instead of being assumed.
 */
export function mayHoldExternalSession(role: Role): boolean {
  return EXTERNAL_ROLES.includes(role);
}

interface StoredSession {
  userId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedSession {
  /** The bearer value for the cookie. Returned once and never stored raw. */
  sessionToken: string;
  expiresAt: string;
}

/**
 * KV key for a session.
 *
 * The stored key is a hash, so a dump of the namespace cannot be replayed as a
 * set of live sessions -- the same reasoning as login_tokens. It costs one
 * digest per request.
 */
async function sessionKey(sessionToken: string): Promise<string> {
  return `session:${await hashToken(sessionToken)}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Start a session for a user who has just spent a valid magic link. */
export async function createSession(
  env: Env,
  userId: string,
  opts: { now?: Date } = {},
): Promise<IssuedSession> {
  const now = opts.now ?? new Date();
  const sessionToken = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const record: StoredSession = {
    userId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await env.SESSIONS.put(await sessionKey(sessionToken), JSON.stringify(record), {
    // KV expires the record on its own, so an abandoned session does not sit
    // in the namespace indefinitely. The expiry is ALSO checked on read,
    // because KV's TTL is a cleanup mechanism and not an access control.
    expirationTtl: Math.floor(SESSION_TTL_MS / 1000),
  });

  return { sessionToken, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolve a session token to a Session, or null.
 *
 * Null for every failure -- missing, expired, revoked, deactivated, unknown
 * user, or a staff role arriving down the external path. The caller turns that
 * into one message. Distinguishing them to an unauthenticated caller would
 * describe the state of somebody else's account to whoever holds a stale
 * cookie.
 */
export async function resolveSession(
  env: Env,
  sessionToken: string,
  opts: { now?: Date } = {},
): Promise<Session | null> {
  if (!sessionToken) return null;
  const now = opts.now ?? new Date();

  const raw = await env.SESSIONS.get(await sessionKey(sessionToken));
  if (!raw) return null;

  let record: StoredSession;
  try {
    record = JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
  if (!record?.userId || !record.expiresAt || !record.issuedAt) return null;

  const expiresAt = Date.parse(record.expiresAt);
  const issuedAt = Date.parse(record.issuedAt);
  // A record whose timestamps do not parse is not a session. Treating an
  // unreadable expiry as "not expired" would make a corrupt value permanent.
  if (Number.isNaN(expiresAt) || Number.isNaN(issuedAt)) return null;
  if (expiresAt <= now.getTime()) return null;

  const user = await env.DB.prepare(
    `SELECT id, email, role, organization_id, is_active, sessions_valid_from
       FROM users WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(record.userId)
    .first<{
      id: string;
      email: string;
      role: Role;
      organization_id: string | null;
      is_active: number;
      sessions_valid_from: string | null;
    }>();

  if (!user || user.is_active !== 1) return null;
  if (!mayHoldExternalSession(user.role)) return null;
  // The schema requires this for external roles; a null here means the row is
  // malformed, and an applicant session with no organization would scope to
  // nothing or, worse, to everything if a caller forgot to check.
  if (!user.organization_id) return null;

  if (isRevoked(record.issuedAt, user.sessions_valid_from)) return null;

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organization_id,
  };
}

/**
 * Was this session issued before the user's sessions were invalidated?
 *
 * An unparseable `sessions_valid_from` is treated as revoking everything. The
 * safe direction: a corrupt value signs people out rather than silently
 * disabling the revocation mechanism.
 */
export function isRevoked(issuedAt: string, validFrom: string | null | undefined): boolean {
  if (!validFrom) return false;
  const cutoff = Date.parse(validFrom);
  if (Number.isNaN(cutoff)) return true;
  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued)) return true;
  // Inclusive. Workers freeze Date.now() between I/O, so two requests on one
  // edge genuinely share a timestamp -- an in-flight magic-link redemption
  // racing a sign-out is the realistic case, and a strict comparison lets that
  // session survive the sign-out that was meant to kill it.
  return issued <= cutoff;
}

/**
 * End every session for a user, immediately.
 *
 * Deletes this session's KV record AND moves the revocation cutoff. The second
 * is what makes it immediate and what covers the person's other devices; the
 * first is only housekeeping.
 */
export async function signOut(
  env: Env,
  sessionToken: string | null,
  userId: string,
  opts: { now?: Date } = {},
): Promise<void> {
  const now = (opts.now ?? new Date()).toISOString();
  await env.DB.prepare(`UPDATE users SET sessions_valid_from = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, userId)
    .run();
  if (sessionToken) {
    await env.SESSIONS.delete(await sessionKey(sessionToken));
  }
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/**
 * `__Host-` prefix: the browser refuses to accept this cookie unless it is
 * Secure, has no Domain attribute, and has Path=/. That makes it impossible
 * for a sibling subdomain to set or overwrite it -- staff live on
 * grants.houstontexansfoundation.org and applicants on
 * applications.houstontexansfoundation.org, and a cookie scoped to the parent
 * domain would be readable across both.
 */
export const SESSION_COOKIE = '__Host-steward_session';

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    // Lax rather than Strict: a magic link arrives from an email client, and
    // Strict would drop the cookie on that first cross-site navigation --
    // signing the person in and immediately appearing not to.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** An expired cookie with an empty value, for sign-out. */
export function clearedSessionCookie(): string {
  return sessionCookie('', 0);
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return value || null;
    }
  }
  return null;
}
