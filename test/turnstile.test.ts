/**
 * Bot protection on the public endpoints.
 *
 * WHY THIS FILE EXISTS. There were no tests for this function, and it failed
 * OPEN on the deployment that serves nonprofits.
 *
 * The rule was: with no secret configured, refuse only when
 * `ENVIRONMENT === 'production'`, and skip everywhere else so a preview run
 * works without a Cloudflare account. Reasonable in isolation. But the Worker
 * serving `apply.<domain>` to the public sets `ENVIRONMENT = "preview"`, so the
 * public form had no bot protection at all -- silently, recorded in the result
 * as `skipped`, which nothing read.
 *
 * A LABEL IS NOT A SAFETY PROPERTY. The rule now fails closed by default, and
 * an environment that is genuinely unreachable says so with an explicit var
 * that `check:config` refuses to find in the default or production blocks.
 *
 * What it costs when this is wrong, stated because it is easy to file bot
 * protection under "nice to have": the eligibility endpoint MAILS ANY ADDRESS
 * IT IS GIVEN. Rate limits are per IP and per address, which a distributed
 * script walks around, and the free email tier is 3,000 messages a month.
 * Exhaust it and real grantees stop receiving sign-in links.
 */

import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from '../src/lib/turnstile';
import type { Env } from '../src/types';

const env = (over: Partial<Env> = {}): Env => ({ ENVIRONMENT: 'preview', ...over }) as Env;

/** A siteverify that must never be called. */
const noFetch = (() => {
  throw new Error('siteverify must not be called when no secret is configured');
}) as unknown as typeof fetch;

const siteverify = (success: boolean) =>
  (async () => new Response(JSON.stringify({ success }), { status: 200 })) as unknown as typeof fetch;

describe('when no secret is configured', () => {
  it('FAILS CLOSED on an environment that has not said it is private', async () => {
    // THE REGRESSION TEST. ENVIRONMENT is "preview" on the deployment serving
    // apply.<domain>, and this used to return { ok: true, skipped: true }.
    const result = await verifyTurnstile(env(), 'anything', null, noFetch);
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('skips only when the environment explicitly says it is not public', async () => {
    const result = await verifyTurnstile(env({ TURNSTILE_OPTIONAL: '1' }), null, null, noFetch);
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('takes exactly "1", not anything truthy', async () => {
    // 'true', 'yes' and '0' are all the kind of value somebody types in a
    // hurry. None of them may open a public form.
    for (const value of ['true', 'yes', '0', 'TRUE', ' 1', '']) {
      const result = await verifyTurnstile(
        env({ TURNSTILE_OPTIONAL: value }),
        null,
        null,
        noFetch,
      );
      expect(result, `TURNSTILE_OPTIONAL=${JSON.stringify(value)} must not skip`).toEqual({
        ok: false,
        reason: 'not_configured',
      });
    }
  });

  it('refuses in production even when the opt-out is set', async () => {
    // Two independent guards: check:config refuses this var in the production
    // block, and this refuses to honour it if it ever gets there anyway.
    const result = await verifyTurnstile(
      env({ ENVIRONMENT: 'production', TURNSTILE_OPTIONAL: '1' }),
      null,
      null,
      noFetch,
    );
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('when a secret is configured', () => {
  const configured = { TURNSTILE_SECRET_KEY: 'invented-secret' };

  it('refuses a request with no token', async () => {
    const result = await verifyTurnstile(env(configured), null, null, noFetch);
    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('accepts a token Cloudflare verifies', async () => {
    const result = await verifyTurnstile(env(configured), 'tok', '203.0.113.1', siteverify(true));
    expect(result).toEqual({ ok: true });
  });

  it('refuses a token Cloudflare rejects', async () => {
    const result = await verifyTurnstile(env(configured), 'tok', null, siteverify(false));
    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it('refuses when Cloudflare cannot be reached', async () => {
    // Not the applicant's fault, and admitting an unverified request would
    // make "Turnstile is down" the way past it.
    const dead = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const result = await verifyTurnstile(env(configured), 'tok', null, dead);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ignores the opt-out entirely once a secret exists', async () => {
    const result = await verifyTurnstile(
      env({ ...configured, TURNSTILE_OPTIONAL: '1' }),
      null,
      null,
      noFetch,
    );
    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });
});
