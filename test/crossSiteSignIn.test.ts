import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { isSameOriginRequest } from '../src/lib/httpHeaders';
import { issueLoginToken } from '../src/lib/tokens';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

const ORIGIN = 'https://applications.example.org';
const envFor = (): Env => ({ ...(testEnv as unknown as Env), APPLICANT_BASE_URL: ORIGIN });

let n = 0;
async function applicantWithLink() {
  const now = nowIso();
  const orgId = newId();
  const userId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Org ${++n}`, String(800000000 + n), now, now).run();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
  ).bind(userId, `a${n}-${newId().slice(0, 6)}@example.org`, orgId, now, now).run();
  const issued = await issueLoginToken(db, ctxFor(adminSession()), {
    userId,
    email: `a${n}@example.org`,
  });
  return { userId, token: issued.token, tokenId: issued.tokenId };
}

const verify = (token: string, headers: Record<string, string>) =>
  worker.fetch(
    new Request(`${ORIGIN}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': '203.0.113.77',
        ...headers,
      },
      body: new URLSearchParams({ token }).toString(),
    }),
    envFor(),
    {} as ExecutionContext,
  );

beforeEach(async () => {
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('the same-origin check itself', () => {
  const req = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/api/auth/verify`, { method: 'POST', headers });

  it('accepts a request the browser marks as same-origin', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(true);
  });

  it('refuses every other Sec-Fetch-Site value', () => {
    // 'none' is a typed URL or a bookmark. A form POST is never 'none', so
    // accepting it would readmit exactly what this refuses.
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(isSameOriginRequest(req({ 'sec-fetch-site': site }), ORIGIN), site).toBe(false);
    }
  });

  it('falls back to Origin when Sec-Fetch-Site is absent', () => {
    expect(isSameOriginRequest(req({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://evil.example' }), ORIGIN)).toBe(false);
  });

  it('ignores a trailing slash and a path on the configured origin', () => {
    expect(isSameOriginRequest(req({ origin: ORIGIN }), `${ORIGIN}/`)).toBe(true);
    expect(isSameOriginRequest(req({ origin: ORIGIN }), `${ORIGIN}/apply`)).toBe(true);
  });

  it('fails CLOSED when the request offers neither signal', () => {
    // A browser always sends at least one of them. Something that sends
    // neither is not the browser this route exists for.
    expect(isSameOriginRequest(req({}), ORIGIN)).toBe(false);
  });

  it('fails closed when no origin is configured', () => {
    expect(isSameOriginRequest(req({ origin: ORIGIN }), '')).toBe(false);
    expect(isSameOriginRequest(req({ origin: ORIGIN }), '   ')).toBe(false);
  });

  it('is not fooled by an origin that merely starts the same', () => {
    expect(isSameOriginRequest(req({ origin: 'https://applications.example.org.evil.test' }), ORIGIN))
      .toBe(false);
    expect(isSameOriginRequest(req({ origin: 'http://applications.example.org' }), ORIGIN))
      .toBe(false);
  });

  it('refuses a malformed origin rather than throwing', () => {
    expect(isSameOriginRequest(req({ origin: 'not a url' }), ORIGIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('login CSRF on the route that mints a session', () => {
  it('refuses a cross-site POST and sets no cookie', async () => {
    const a = await applicantWithLink();
    const res = await verify(a.token, { 'sec-fetch-site': 'cross-site' });

    expect(res.headers.get('set-cookie'), 'no session was installed').toBeNull();
    expect(res.status).not.toBe(303);
    expect(await res.text()).toMatch(/directly from the email/);
  });

  it('does NOT spend the single-use link when it refuses', async () => {
    // Checked before the token is read. Otherwise an attacker could burn
    // somebody's link from a page they merely visited.
    const a = await applicantWithLink();
    await verify(a.token, { 'sec-fetch-site': 'cross-site' });

    const row = await db.prepare(`SELECT consumed_at FROM login_tokens WHERE id=?`)
      .bind(a.tokenId).first<{ consumed_at: string | null }>();
    expect(row!.consumed_at).toBeNull();

    // And it still works from our own page.
    const ok = await verify(a.token, { 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toContain('__Host-steward_session=');
  });

  it('records the refusal rather than failing silently', async () => {
    const a = await applicantWithLink();
    await verify(a.token, { origin: 'https://evil.example' });
    const logged = await db.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE code='CROSS_SITE_SIGN_IN_BLOCKED'`,
    ).first<{ n: number }>();
    expect(logged!.n).toBeGreaterThan(0);
  });

  it('still lets a real sign-in through', async () => {
    // The control. Without it every test above passes for a route that
    // refuses everybody.
    const a = await applicantWithLink();
    const res = await verify(a.token, { 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });
});
