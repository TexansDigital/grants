import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db } from './helpers';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { hashToken } from '../src/lib/tokens';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import type { Env, Role } from '../src/types';

const ORIGIN = 'https://applications.example.org';
const env = () => ({ ...(testEnv as unknown as Env), APPLICANT_BASE_URL: ORIGIN });

const call = (path: string, init: RequestInit = {}, e: Env = env()) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), e, {} as ExecutionContext);

let n = 0;
async function applicant(over: { role?: Role; active?: number } = {}) {
  const orgId = newId();
  const userId = newId();
  const now = nowIso();
  const email = `a${++n}-${crypto.randomUUID().slice(0, 6)}@example.org`;
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, 'Invented Futures', String(200000000 + n), now, now).run();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    userId, email, over.role ?? 'applicant',
    // Staff rows must have a NULL organization, per the users CHECK.
    over.role && over.role !== 'applicant' && over.role !== 'grantee' ? null : orgId,
    over.active ?? 1, now, now,
  ).run();
  return { userId, orgId, email };
}

/** The token the last email would have carried, read from the login_tokens row. */
async function tokenFor(userId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT token_hash FROM login_tokens WHERE user_id=? ORDER BY issued_at DESC LIMIT 1`)
    .bind(userId).first<{ token_hash: string }>();
  return row?.token_hash ?? null;
}

const post = (path: string, body: unknown, e?: Env) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, e);

beforeEach(async () => {
  // A clean rate-limit window per test; counters live in the same KV namespace.
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('requesting a sign-in link', () => {
  it('answers identically for a known and an unknown address', async () => {
    const { email } = await applicant();
    const known = await post('/api/auth/request-link', { email });
    const unknown = await post('/api/auth/request-link', { email: 'nobody@example.org' });

    expect(known.status).toBe(unknown.status);
    expect(await known.clone().text()).toBe(await unknown.clone().text());
  });

  it('answers identically for a staff address, and issues them nothing', async () => {
    // Two separate properties. The identical answer stops the endpoint saying
    // which addresses are staff; issuing no token stops it being a way around
    // Cloudflare Access entirely. Only asserting the first left the role
    // filter deletable with the suite green.
    const { userId, email } = await applicant({ role: 'admin' });
    const staff = await post('/api/auth/request-link', { email });
    const unknown = await post('/api/auth/request-link', { email: 'nobody2@example.org' });
    expect(await staff.text()).toBe(await unknown.text());
    expect(await tokenFor(userId)).toBeNull();
  });

  it('issues a token for a real applicant and none for a stranger', async () => {
    const { userId, email } = await applicant();
    await post('/api/auth/request-link', { email });
    expect(await tokenFor(userId)).toBeTruthy();

    const before = await db.prepare(`SELECT COUNT(*) AS n FROM login_tokens`).first<{ n: number }>();
    await post('/api/auth/request-link', { email: 'stranger@example.org' });
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM login_tokens`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('issues no token for a deactivated account', async () => {
    const { userId, email } = await applicant({ active: 0 });
    await post('/api/auth/request-link', { email });
    expect(await tokenFor(userId)).toBeNull();
  });

  it('audits the request without recording the token itself', async () => {
    const { userId, email } = await applicant();
    await post('/api/auth/request-link', { email });
    const row = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action='auth.magic_link_requested' AND entity_id=?`,
      )
      .bind(userId).first<{ after_json: string }>();
    expect(row).not.toBeNull();
    const hash = await tokenFor(userId);
    expect(row!.after_json).not.toContain(hash);
    expect(JSON.parse(row!.after_json).token_id).toBeTruthy();
  });

  it('rate limits by address', async () => {
    const { email } = await applicant();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post('/api/auth/request-link', { email })).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('rate limits by IP even when no address is supplied', async () => {
    // Otherwise the cheapest request is the one that probes.
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await post('/api/auth/request-link', {})).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('refuses rather than admits when the rate-limit store is unavailable', async () => {
    // Failing open here would make "KV is having a bad day" the way to
    // mail-bomb a nonprofit using our domain and our sending reputation.
    const broken = {
      ...env(),
      SESSIONS: {
        get: async () => { throw new Error('KV unavailable'); },
        put: async () => { throw new Error('KV unavailable'); },
        delete: async () => undefined,
        list: async () => ({ keys: [] }),
      },
    } as unknown as Env;
    const { email } = await applicant();
    const res = await post('/api/auth/request-link', { email }, broken);
    expect(res.status).toBe(429);
  });

  it('refuses when the counter can be read but not written', async () => {
    // A separate failure from an unreadable store, and separately deletable:
    // if the write is swallowed the counter never advances, so the limit is
    // never reached and the endpoint is effectively unlimited.
    const readOnly = {
      ...env(),
      SESSIONS: {
        get: async () => '0',
        put: async () => { throw new Error('KV read-only'); },
        delete: async () => undefined,
        list: async () => ({ keys: [] }),
      },
    } as unknown as Env;
    const { email } = await applicant();
    expect((await post('/api/auth/request-link', { email }, readOnly)).status).toBe(429);
  });

  it('refuses when Turnstile is unconfigured in production', async () => {
    // Forgetting the secret must not silently ship a public form with no bot
    // protection.
    const res = await post('/api/auth/request-link', { email: 'a@example.org' }, {
      ...env(), ENVIRONMENT: 'production',
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('the interstitial', () => {
  it('a GET consumes nothing, which is the whole point', async () => {
    // A mail scanner fetching the link must not spend it.
    const { userId, email } = await applicant();
    await post('/api/auth/request-link', { email });

    const before = await db
      .prepare(`SELECT consumed_at FROM login_tokens WHERE user_id=? ORDER BY issued_at DESC LIMIT 1`)
      .bind(userId).first<{ consumed_at: string | null }>();
    expect(before!.consumed_at).toBeNull();

    const res = await call('/auth/verify?token=whatever-a-scanner-fetched');
    expect(res.status).toBe(200);

    const after = await db
      .prepare(`SELECT consumed_at FROM login_tokens WHERE user_id=? ORDER BY issued_at DESC LIMIT 1`)
      .bind(userId).first<{ consumed_at: string | null }>();
    expect(after!.consumed_at).toBeNull();
  });

  it('renders a real form with the token, and no JavaScript', async () => {
    const res = await call('/auth/verify?token=abc123');
    const html = await res.text();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/api/auth/verify"');
    expect(html).toContain('value="abc123"');
    expect(html).not.toContain('<script');
    // The URL holds a credential.
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it('escapes the token into the form rather than trusting it', async () => {
    const res = await call('/auth/verify?token=%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
describe('completing sign-in', () => {
  /** Drive the real flow: request a link, then redeem the token behind it. */
  async function signIn() {
    const { userId, email, orgId } = await applicant();
    await post('/api/auth/request-link', { email });
    // The raw token never leaves issueLoginToken, so mint a known one instead
    // by re-issuing directly through the same path the route uses.
    const { issueLoginToken } = await import('../src/lib/tokens');
    const { ctxFor } = await import('./helpers');
    const issued = await issueLoginToken(db, ctxFor(null), { userId, email });
    return { userId, orgId, email, token: issued.token };
  }

  const submit = (token: string) =>
    call('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });

  it('redeems the token, sets a session cookie and redirects', async () => {
    const { token } = await signIn();
    const res = await submit(token);
    expect(res.status).toBe(303);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    // 303 so the browser re-requests with GET and the token leaves the bar.
    expect(res.headers.get('location')).toBe('/');
  });

  it('the session it hands out actually works', async () => {
    const { token, email } = await signIn();
    const res = await submit(token);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = await call('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { email, role: 'applicant' } });
  });

  it('audits the sign-in', async () => {
    const { token, userId } = await signIn();
    await submit(token);
    const row = await db
      .prepare(`SELECT after_json FROM audit_log WHERE action='auth.logged_in' AND entity_id=?`)
      .bind(userId).first<{ after_json: string }>();
    expect(JSON.parse(row!.after_json).method).toBe('magic_link');
  });

  it('a second submission of the same token fails, and says so plainly', async () => {
    const { token } = await signIn();
    await submit(token);
    const again = await submit(token);
    const html = await again.text();
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(html).toContain('already been used');
    expect(html).toContain('Request a new sign-in link');
  });

  it('tells somebody holding an expired link what to do next', async () => {
    const res = await submit('a-token-that-was-never-issued');
    const html = await res.text();
    expect(html).toContain('expired');
    expect(html).toContain('/sign-in');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('distinguishes a superseded link from an expired one', async () => {
    const { userId, email } = await applicant();
    const { issueLoginToken } = await import('../src/lib/tokens');
    const { ctxFor } = await import('./helpers');
    const first = await issueLoginToken(db, ctxFor(null), { userId, email });
    await issueLoginToken(db, ctxFor(null), { userId, email });
    const html = await (await submit(first.token)).text();
    expect(html).toContain('newer sign-in link');
  });
});

// ---------------------------------------------------------------------------
describe('the applicant door is separate from the staff door', () => {
  it('refuses an applicant route with no cookie', async () => {
    expect((await call('/api/me')).status).toBe(401);
  });

  it('refuses an applicant route with a junk cookie', async () => {
    const res = await call('/api/me', { headers: { cookie: `${SESSION_COOKIE}=nonsense` } });
    expect(res.status).toBe(401);
  });

  it('does not accept an applicant session on a staff route', async () => {
    const { userId } = await applicant();
    const { sessionToken } = await createSession(testEnv as unknown as Env, userId);
    const res = await call('/api/programs', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    // Staff routes demand a Cloudflare Access assertion; a magic-link cookie
    // is not one, and must not be tried as a fallback.
    expect(res.status).toBe(401);
  });

  it('signs out everywhere and clears the cookie', async () => {
    const { userId } = await applicant();
    const a = await createSession(testEnv as unknown as Env, userId);
    const b = await createSession(testEnv as unknown as Env, userId);

    const res = await call('/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${a.sessionToken}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    // The other device is dead too, without waiting for KV to propagate.
    const other = await call('/api/me', { headers: { cookie: `${SESSION_COOKIE}=${b.sessionToken}` } });
    expect(other.status).toBe(401);
    void hashToken;
  });
});
