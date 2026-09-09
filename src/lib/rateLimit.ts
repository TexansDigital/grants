/**
 * Rate limiting for public endpoints.
 *
 * Fixed windows in KV. KV is eventually consistent and read-then-write here is
 * not atomic, so two simultaneous requests can both read the same count and a
 * burst can overshoot the limit slightly. That is ACCEPTABLE and deliberate:
 * this exists to stop somebody sending a thousand sign-in emails to an address
 * they do not own, not to enforce an exact quota. Overshooting by one or two
 * costs nothing; the alternative -- a D1 write on every public request --
 * spends the one resource this system is genuinely constrained on.
 *
 * WHAT IS NOT ACCEPTABLE is failing open. If KV is unavailable, a request is
 * refused rather than allowed: an unprotected sign-in endpoint is a way to
 * mail-bomb a nonprofit using our domain and our sending reputation.
 */

import type { Env } from '../types';
import { hashToken } from './tokens';

export interface RateLimitRule {
  /** What is being limited, e.g. 'signin_email'. Part of the key. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Subjects are HASHED into the key.
 *
 * An email address is personal data and a KV namespace is not the place to
 * keep a plaintext list of everybody who has ever tried to sign in.
 */
async function limitKey(rule: RateLimitRule, subject: string, now: number): Promise<string> {
  const window = Math.floor(now / (rule.windowSeconds * 1000));
  return `rl:${rule.name}:${window}:${(await hashToken(subject.toLowerCase())).slice(0, 32)}`;
}

export async function checkRateLimit(
  env: Env,
  rule: RateLimitRule,
  subject: string,
  opts: { now?: number } = {},
): Promise<RateLimitResult> {
  const now = opts.now ?? Date.now();
  const key = await limitKey(rule, subject, now);
  const windowMs = rule.windowSeconds * 1000;
  const retryAfterSeconds = Math.ceil((windowMs - (now % windowMs)) / 1000);

  let count = 0;
  try {
    const raw = await env.SESSIONS.get(key);
    count = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(count) || count < 0) count = 0;
  } catch {
    // Fail closed. See the header: an unprotected sign-in endpoint is a way to
    // mail-bomb somebody using our domain.
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  if (count >= rule.limit) return { allowed: false, remaining: 0, retryAfterSeconds };

  try {
    await env.SESSIONS.put(key, String(count + 1), {
      // Two windows of TTL so a counter written at the very end of a window is
      // still readable for the whole of it. KV's minimum TTL is 60 seconds.
      expirationTtl: Math.max(60, rule.windowSeconds * 2),
    });
  } catch {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: rule.limit - count - 1, retryAfterSeconds };
}

/**
 * Sign-in limits.
 *
 * Per address: five links in fifteen minutes. A person who genuinely did not
 * receive the first email will try two or three times; five is generous and
 * still far short of a mailbox full.
 *
 * Per IP: twenty in an hour, which covers a whole nonprofit office behind one
 * NAT while stopping a single host from walking a list of addresses.
 */
export const SIGN_IN_EMAIL_LIMIT: RateLimitRule = {
  name: 'signin_email',
  limit: 5,
  windowSeconds: 15 * 60,
};

export const SIGN_IN_IP_LIMIT: RateLimitRule = {
  name: 'signin_ip',
  limit: 20,
  windowSeconds: 60 * 60,
};
