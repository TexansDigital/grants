/**
 * Magic-link tokens.
 *
 * The security properties this file is responsible for, in the order they
 * matter:
 *
 *   1. UNGUESSABLE. 32 bytes from the CSPRNG. Not a UUID -- v4 carries 122
 *      bits with six of them fixed by the format, and a token is a credential
 *      rather than an identifier.
 *   2. NEVER STORED. Only the SHA-256 hash reaches the database, so a copy of
 *      the database cannot be used to sign in as anybody.
 *   3. SINGLE USE. Enforced by one conditional UPDATE whose row count decides
 *      the outcome, not by read-then-write. Two simultaneous clicks produce
 *      exactly one session.
 *   4. SHORT LIVED. Fifteen minutes, checked in SQL against the same clock
 *      that writes the row rather than in JavaScript against the caller's.
 *
 * The token is returned to the caller exactly once, from `issueLoginToken`,
 * and must go straight into an email. It is never logged, never audited, and
 * never put in an error message.
 */

import type { RequestContext } from '../types';
import { newId } from './ids';
import { nowIso } from './time';

/** 32 bytes. Comfortably beyond brute force, and short enough for a URL. */
const TOKEN_BYTES = 32;

/** CLAUDE.md: magic-link tokens are single-use with a 15-minute expiry. */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface IssuedToken {
  /** The raw token. Goes into the email and nowhere else, ever. */
  token: string;
  /** The row id, safe to log and audit. */
  tokenId: string;
  expiresAt: string;
}

/**
 * Base64url without padding.
 *
 * URL-safe by construction so the token survives being placed in a query
 * string, copied out of an email client that breaks lines, and pasted back.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** SHA-256, lowercase hex. The only form of a token that touches storage. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a token for a user and record its hash.
 *
 * Does NOT send anything. The caller pairs this with sendEmail, so that the
 * only code holding a raw token is the code that puts it in a message.
 */
export async function issueLoginToken(
  db: D1Database,
  ctx: RequestContext,
  opts: { userId: string; email: string; now?: Date },
): Promise<IssuedToken> {
  const now = opts.now ?? new Date();
  // Supersede FIRST, then issue. Doing it the other way round -- which the old
  // standalone helper invited, and whose docstring actively suggested -- kills
  // the link that is already in the email, silently, for every applicant. The
  // order is not something a caller should be able to get wrong, so it is not
  // a caller's decision any more.
  await supersedeOutstandingTokens(db, opts.userId, { now });

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const tokenId = newId();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO login_tokens
         (id, token_hash, user_id, sent_to_email, purpose, issued_at, expires_at,
          requested_ip, requested_user_agent, created_at)
       VALUES (?,?,?,?,'sign_in',?,?,?,?,?)`,
    )
    .bind(
      tokenId,
      tokenHash,
      opts.userId,
      opts.email.trim().toLowerCase(),
      issuedAt,
      expiresAt,
      ctx.ip,
      ctx.userAgent,
      issuedAt,
    )
    .run();

  return { token, tokenId, expiresAt };
}

export type ConsumeResult =
  | { ok: true; userId: string; tokenId: string; email: string }
  /**
   * Why it failed, for the message shown to the person holding the link.
   *
   * Distinguishing these is deliberate and is NOT an enumeration risk: you
   * cannot reach any of them without already possessing a token. Telling
   * somebody their link expired, so they can request another, is the
   * difference between a recoverable moment and a dead end.
   */
  | { ok: false; reason: 'unknown' | 'expired' | 'already_used' | 'superseded' };

/**
 * Spend a token, once.
 *
 * The UPDATE is the whole mechanism. It matches only a token that is unused
 * AND unexpired, and D1 reports how many rows changed. One statement, no
 * read-then-write, so concurrent clicks cannot both win. The follow-up SELECT
 * runs only to explain a failure that already happened; it never grants
 * anything.
 */
export async function consumeLoginToken(
  db: D1Database,
  ctx: RequestContext,
  token: string,
  opts: { now?: Date } = {},
): Promise<ConsumeResult> {
  const tokenHash = await hashToken(token);
  const now = (opts.now ?? new Date()).toISOString();

  const claimed = await db
    .prepare(
      `UPDATE login_tokens
          SET consumed_at = ?, consumed_ip = ?, consumed_user_agent = ?
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND superseded_at IS NULL
          AND expires_at > ?
          -- The account must still be live AT REDEMPTION, checked here rather
          -- than by the caller: resolveSession would catch a dead account on
          -- the next request, but any route that trusts ok:true would first
          -- have set a cookie and told somebody they were signed in.
          AND EXISTS (
            SELECT 1 FROM users u
             WHERE u.id = login_tokens.user_id
               AND u.is_active = 1
               AND u.deleted_at IS NULL
          )`,
    )
    .bind(now, ctx.ip, ctx.userAgent, tokenHash, now)
    .run();

  if (claimed.meta.changes >= 1) {
    const row = await db
      .prepare(`SELECT id, user_id, sent_to_email FROM login_tokens WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ id: string; user_id: string; sent_to_email: string }>();
    // Unreachable unless the row vanished between two statements, which the
    // no-delete trigger forbids. Failing closed beats returning a session
    // with an undefined user id.
    if (!row) return { ok: false, reason: 'unknown' };
    return { ok: true, userId: row.user_id, tokenId: row.id, email: row.sent_to_email };
  }

  const existing = await db
    .prepare(
      `SELECT consumed_at, superseded_at, expires_at FROM login_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ consumed_at: string | null; superseded_at: string | null; expires_at: string }>();

  if (!existing) return { ok: false, reason: 'unknown' };
  if (existing.consumed_at !== null) return { ok: false, reason: 'already_used' };
  // Checked before expiry: a superseded link is usually also old, and "we sent
  // you a newer one, check your inbox" is a more useful thing to be told than
  // "this expired".
  if (existing.superseded_at !== null) return { ok: false, reason: 'superseded' };
  return { ok: false, reason: 'expired' };
}

/**
 * Void every outstanding token for a user.
 *
 * Called BY `issueLoginToken`, before it mints the replacement. Exported for
 * an admin revoking access, not for the issue path -- calling it after issuing
 * voids the link you just sent.
 *
 * Without this, every link ever sent stays live for its full fifteen minutes.
 * Somebody who clicks "send me another" because the first did not arrive would
 * leave two working credentials sitting in an inbox, and the older one is the
 * one an attacker who saw a forwarded email would have.
 *
 * Marked superseded, NOT consumed: the row stays as evidence a link was
 * issued, without claiming somebody signed in with it. Never deleted.
 */
export async function supersedeOutstandingTokens(
  db: D1Database,
  userId: string,
  opts: { now?: Date } = {},
): Promise<number> {
  const now = (opts.now ?? new Date()).toISOString();
  const res = await db
    .prepare(
      `UPDATE login_tokens
          SET superseded_at = ?
        WHERE user_id = ?
          AND consumed_at IS NULL
          AND superseded_at IS NULL
          AND expires_at > ?`,
    )
    .bind(now, userId, now)
    .run();
  return res.meta.changes ?? 0;
}
