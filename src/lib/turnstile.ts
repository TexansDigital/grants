/**
 * Cloudflare Turnstile verification.
 *
 * CLAUDE.md requires Turnstile on all public endpoints. The interesting part
 * of this file is what happens when the secret is not configured.
 */

import type { Env } from '../types';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;

export type TurnstileResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: 'missing_token' | 'rejected' | 'unavailable' | 'not_configured' };

/**
 * Verify a Turnstile response token.
 *
 * WHEN THE SECRET IS NOT SET, the behaviour depends on the environment, and
 * the asymmetry is the point:
 *
 *   production  -> FAIL CLOSED. Forgetting the secret must not silently ship a
 *                  public form with no bot protection. A loud failure on the
 *                  first request beats a quiet one discovered in the logs.
 *   anything else -> skip, so preview and the test suite work without a
 *                  Cloudflare account. Recorded in the result as `skipped`, so
 *                  a caller that cares can tell the difference.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null | undefined,
  ip: string | null,
  fetcher: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!secret) {
    if (env.ENVIRONMENT === 'production') return { ok: false, reason: 'not_configured' };
    return { ok: true, skipped: true };
  }

  if (!token) return { ok: false, reason: 'missing_token' };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);

    const res = await fetcher(SITEVERIFY, { method: 'POST', body, signal: abort.signal });
    if (!res.ok) return { ok: false, reason: 'unavailable' };

    const json = (await res.json().catch(() => null)) as { success?: unknown } | null;
    return json?.success === true ? { ok: true } : { ok: false, reason: 'rejected' };
  } catch {
    // Cloudflare being unreachable is not the applicant's fault, but admitting
    // an unverified request would make "Turnstile is down" the way past it.
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
