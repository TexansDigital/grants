import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { signedInDestination } from '../src/lib/authRoutes';
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

  /**
   * Sec-Fetch-Site is what a real browser sends when the form on our own
   * interstitial is submitted, and the route refuses a POST without it. Tests
   * that omitted it were not simulating a browser; they were simulating the
   * attack the guard exists to stop. The guard itself is tested in
   * test/crossSiteSignIn.test.ts.
   */
  const submit = (token: string, over: Record<string, string> = {}) =>
    call('/api/auth/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        ...over,
      },
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
    // Never '/', which is the STAFF pipeline: landing an applicant or a
    // grantee there told them their Cloudflare Access session had expired.
    expect(res.headers.get('location')).toBe('/reports');
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
    // On the STAFF hostname, where the route exists at all. Staff routes demand
    // a Cloudflare Access assertion; a magic-link cookie is not one, and must
    // not be tried as a fallback.
    const res = await worker.fetch(
      new Request('https://staff.example.org/api/programs', {
        headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('does not serve a staff route on the applicant hostname at all', async () => {
    const { userId } = await applicant();
    const { sessionToken } = await createSession(testEnv as unknown as Env, userId);
    // 404, not 401 and not 403: on the hostname nonprofits use, a staff route
    // does not exist. A 403 would confirm it exists somewhere to anyone poking
    // at apply.<domain>/api/applications.
    //
    // This is the boundary that used to live ONLY in the Cloudflare Access
    // application's destination list -- a dashboard setting that silently
    // widened to cover the applicant hostname the day a second custom domain
    // was added to the same Worker.
    const res = await call('/api/programs', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('answers the same on the applicant hostname whatever credentials arrive', async () => {
    // The guard runs BEFORE authentication, so the answer cannot depend on who
    // is asking. An Access assertion that would otherwise be REJECTED -- and
    // therefore produce 401 -- still produces 404 here, which is only possible
    // if the hostname check ran first.
    const bare = await call('/api/programs');
    const withAssertion = await call('/api/programs', {
      headers: { 'cf-access-jwt-assertion': 'not.a.jwt' },
    });
    expect(bare.status).toBe(404);
    expect(withAssertion.status).toBe(404);
  });

  it('does not serve a PUBLIC staff shell on the applicant hostname', async () => {
    /*
     * The form preview is public -- no roles, no session -- but every call it
     * makes is staff-only, so on the applicant hostname it would render a
     * staff-looking page that then failed. Derivation cannot tell a public
     * staff shell from a public applicant one, so the route carries an
     * explicit marker, and this is what stops the marker being ignored.
     *
     * A stub asset binding, because without one serveAppShell 404s on BOTH
     * hostnames and the assertion would pass while proving nothing. A mutant
     * that skipped the guard for public routes survived until this existed.
     */
    const withAssets = {
      ...env(),
      ASSETS: { fetch: async () => new Response('<!doctype html>', { status: 200 }) },
    } as unknown as Env;
    const onStaff = await worker.fetch(
      new Request('https://staff.example.org/forms/abc'),
      withAssets,
      {} as ExecutionContext,
    );
    const onApplicant = await worker.fetch(
      new Request(`${ORIGIN}/forms/abc`),
      withAssets,
      {} as ExecutionContext,
    );
    expect(onStaff.status).toBe(200);
    expect(onApplicant.status).toBe(404);
  });

  it("sends '/' to the sign-in page on the applicant hostname", async () => {
    // The loop this replaces: '/' served the staff shell, which called
    // /api/session, correctly got 401, and offered a "reload and sign in"
    // button that returned to the staff shell. Forever.
    const res = await call('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in');
  });

  it("does not redirect '/' on the staff hostname", async () => {
    const res = await worker.fetch(
      new Request('https://staff.example.org/'),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).not.toBe(302);
  });

  it('does not split surfaces when APPLICANT_BASE_URL is unset', async () => {
    // Local dev and staging run ONE surface on one hostname. Splitting there
    // would make `wrangler dev` unable to reach the staff app at all.
    //
    // 401 rather than 404 is the whole assertion: the route ran and asked for
    // an Access assertion, which means the hostname guard did not fire.
    const single = { ...(testEnv as unknown as Env), APPLICANT_BASE_URL: '' } as Env;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/programs`),
      single,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('still serves the applicant surface on the applicant hostname', async () => {
    // One direction only. The guard must not have closed the door it exists to
    // protect -- /api/me answering 401 means the route ran and asked for a
    // session, where 404 would mean the guard swallowed it.
    expect((await call('/api/me')).status).toBe(401);
    expect((await call('/sign-in')).status).not.toBe(404);
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

// ---------------------------------------------------------------------------
describe('where a magic link lands somebody', () => {
  it('sends a grantee to the grant portal, never to the staff pipeline', async () => {
    // Before this, everybody landed on '/', which renders the internal shell.
    // Its first API call 401s, and the page told a nonprofit their Cloudflare
    // Access session had expired -- a sentence about a product they have never
    // heard of, on the first screen of their only interaction with us.
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Destination Trust', String(880000001), now, now).run();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
    ).bind(userId, `dest-${newId().slice(0, 8)}@example.org`, orgId, now, now).run();

    expect(await signedInDestination(db, userId)).toBe('/reports');
  });

  it('sends somebody with a draft application back to that draft', async () => {
    // Finishing it is the only reason an applicant asks for a link at all.
    const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `dest-${newId().slice(0, 6)}` });
    const cycleId = Object.values(p.cycleIds)[0]!;
    const stageId = Object.values(p.stageIds)[0]!;
    const formId = Object.values(p.formDefinitionIds)[0]!;
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Halfway Through', String(880000002), now, now).run();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(userId, `draft-${newId().slice(0, 8)}@example.org`, orgId, now, now).run();
    const appId = newId();
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'draft', ?,?)`,
    ).bind(appId, cycleId, stageId, orgId, formId, now, now).run();

    expect(await signedInDestination(db, userId)).toBe(`/apply/${appId}`);
  });

  it('ignores a submitted application and falls back to the portal', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `dest2-${newId().slice(0, 6)}` });
    const cycleId = Object.values(p.cycleIds)[0]!;
    const stageId = Object.values(p.stageIds)[0]!;
    const formId = Object.values(p.formDefinitionIds)[0]!;
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Already Sent', String(880000003), now, now).run();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(userId, `sent-${newId().slice(0, 8)}@example.org`, orgId, now, now).run();
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?, 'submitted', ?,?,?)`,
    ).bind(newId(), cycleId, stageId, orgId, formId, now, now, now).run();

    expect(await signedInDestination(db, userId)).toBe('/reports');
  });

  it('never leaves somebody on a page that does not exist', async () => {
    // An account with nothing at all still lands somewhere honest: the portal
    // says "there are no grants on this account yet" rather than erroring.
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Nothing Yet', String(880000004), now, now).run();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(userId, `none-${newId().slice(0, 8)}@example.org`, orgId, now, now).run();

    expect(await signedInDestination(db, userId)).toBe('/reports');
  });

  it('offers the draft this account owns, never another one', async () => {
    // The join is on the user's own organization. Without it, whoever had the
    // most recently touched draft anywhere got offered it -- which 404s on
    // arrival, because readDraft is scoped, so the link simply breaks.
    const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `dest3-${newId().slice(0, 6)}` });
    const cycleId = Object.values(p.cycleIds)[0]!;
    const stageId = Object.values(p.stageIds)[0]!;
    const formId = Object.values(p.formDefinitionIds)[0]!;
    const now = nowIso();

    const make = async (name: string, ein: string) => {
      const orgId = newId();
      await db.prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      ).bind(orgId, name, ein, now, now).run();
      const userId = newId();
      await db.prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
      ).bind(userId, `${name.toLowerCase().replace(/\W/g, '')}-${newId().slice(0, 6)}@example.org`, orgId, now, now).run();
      const appId = newId();
      await db.prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, created_at, updated_at)
         VALUES (?,?,?,?,?, 'draft', ?,?)`,
      ).bind(appId, cycleId, stageId, orgId, formId, now, now).run();
      return { userId, appId };
    };

    const mine = await make('Mine', String(880000010));
    // Written second, so it is the most recent draft in the table.
    const theirs = await make('Theirs', String(880000011));

    expect(await signedInDestination(db, mine.userId)).toBe(`/apply/${mine.appId}`);
    expect(await signedInDestination(db, theirs.userId)).toBe(`/apply/${theirs.appId}`);
  });

  it('tells a grantee what they are signing in to, in their words', async () => {
    // It said "Inspire Change application" to everybody -- including a grantee
    // whose only business here is a grant they already hold, and including an
    // applicant to any other program this platform runs.
    const g = await applicant({ role: 'grantee' });
    await call('/api/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: g.email }),
    });
    const row = await db.prepare(
      `SELECT subject FROM email_messages WHERE to_email = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(g.email).first<{ subject: string }>();
    expect(row!.subject).toBe('Sign in to your grant reporting');

    const a = await applicant();
    await call('/api/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: a.email }),
    });
    const other = await db.prepare(
      `SELECT subject FROM email_messages WHERE to_email = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(a.email).first<{ subject: string }>();
    expect(other!.subject).toBe('Sign in to your grant application');
  });
});
