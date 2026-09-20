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
    /*
     * FAIL CLOSED unless an environment has explicitly said it is not public.
     *
     * This used to fail closed only when ENVIRONMENT === 'production', and
     * that was wrong in the way that matters: the deployment serving
     * apply.<domain> to real nonprofits sets ENVIRONMENT = "preview". So the
     * public form had NO bot protection, silently, because the guard keyed on
     * a label rather than on whether anyone could reach the page.
     *
     * The label is not the thing. The opt-out is, and it is a var in
     * version control that checkConfig refuses to find in the default or
     * production blocks -- so making the unsafe state requires an edit
     * somebody reviews, rather than a string nobody re-reads.
     *
     * What this costs when it is wrong: the eligibility endpoint mails any
     * address it is given. Rate limits are per IP and per address, which a
     * distributed script walks around, and the free email tier is 3,000 a
     * month. Exhaust it and real grantees stop receiving sign-in links.
     */
    // Production can never skip, whatever the vars say. checkConfig refuses
    // TURNSTILE_OPTIONAL in that block, and this refuses it again -- two
    // independent guards, because the cost of being wrong here is a public
    // form with no bot protection and nothing anywhere saying so.
    if (env.ENVIRONMENT === 'production') return { ok: false, reason: 'not_configured' };
    if (env.TURNSTILE_OPTIONAL === '1') return { ok: true, skipped: true };
    return { ok: false, reason: 'not_configured' };
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
