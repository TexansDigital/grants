import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { __resetJwksCache, ACCESS_JWT_HEADER } from '../src/lib/access';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { submitReport } from '../src/lib/reportSubmit';

/**
 * HTTP-level tests for the staff API.
 *
 * These go through the real fetch handler: routing, Access verification, the
 * error boundary and the response headers. The Phase 0 report noted the
 * authorization tests were library-only; this is the layer that was missing.
 *
 * The Access certs endpoint is stubbed with a locally generated keypair, so no
 * Cloudflare account is involved.
 */

const TEAM = 'texans.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

function b64url(bytes: Uint8Array | string): string {
  const arr = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let signKey: CryptoKey;
let jwks: unknown;
let realFetch: typeof globalThis.fetch;

async function setupKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signKey = pair.privateKey;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as unknown as Record<string, unknown>;
  jwks = { keys: [{ kid: 'kid-1', kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }] };
}

async function mint(email: string, over: Record<string, unknown> = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const p = b64url(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: [AUD],
      email,
      sub: `sub-${email}`,
      iat: nowSec - 60,
      exp: nowSec + 3600,
      ...over,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signKey, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function workerEnv(over: Partial<Env> = {}): Env {
  return {
    ...(testEnv as unknown as Env),
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ENVIRONMENT: 'preview',
    DISPLAY_TIMEZONE: 'America/Chicago',
    ...over,
  };
}

const exec = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(path: string, token?: string, env: Env = workerEnv()): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers[ACCESS_JWT_HEADER] = token;
  return worker.fetch(new Request(`https://steward.example.org${path}`, { headers }), env, exec);
}

async function post(
  path: string,
  token: string,
  body: unknown,
  env: Env = workerEnv(),
): Promise<Response> {
  return worker.fetch(
    new Request(`https://steward.example.org${path}`, {
      method: 'POST',
      headers: { [ACCESS_JWT_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    exec,
  );
}

/** Insert a staff user directly; the seed deliberately contains no users. */
async function makeUser(email: string, role: string, isActive = 1): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
       VALUES (?,?,?,NULL,?,?,?,?)`,
    )
    .bind(id, email, role, email, isActive, now, now)
    .run();
  return id;
}

beforeEach(async () => {
  __resetJwksCache();
  await setupKeys();
  realFetch = globalThis.fetch;
  // Serve the local key set in place of the real Access certs endpoint.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public routes', () => {
  it('serves /health without authentication and touches the database', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; environment: string };
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('preview');
  });

  it('sets the security headers on every response', async () => {
    const res = await call('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('404s an unknown path', async () => {
    const res = await call('/not-a-page');
    expect(res.status).toBe(404);
  });

  it('heads ERROR responses identically to success responses', async () => {
    // These two paths built their headers separately and drifted: error
    // responses shipped without a Content-Security-Policy, which only showed up
    // reading live headers side by side. One builder now serves both.
    const ok = await call('/health');
    const err = await call('/api/session'); // 401
    expect(err.status).toBe(401);

    for (const h of [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'cache-control',
      'content-type',
    ]) {
      expect(err.headers.get(h), `error response is missing ${h}`).toBe(ok.headers.get(h));
    }
    // The request id must differ; it identifies the individual request.
    expect(err.headers.get('x-request-id')).not.toBe(ok.headers.get('x-request-id'));
  });
});

describe('staff API requires a verified Access assertion', () => {
  it('401s with no assertion at all', async () => {
    const res = await call('/api/session');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.message).toBe('Please sign in to continue.');
  });

  it('401s on a garbage assertion', async () => {
    const res = await call('/api/session', 'not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('401s on an expired assertion', async () => {
    await makeUser('admin@example.org', 'admin');
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await call('/api/session', await mint('admin@example.org', { exp: nowSec - 7200 }));
    expect(res.status).toBe(401);
  });

  it('401s on an assertion for a different Access application', async () => {
    await makeUser('admin@example.org', 'admin');
    const res = await call('/api/session', await mint('admin@example.org', { aud: ['b'.repeat(64)] }));
    expect(res.status).toBe(401);
  });

  it('IGNORES the forgeable authenticated-user-email header', async () => {
    await makeUser('admin@example.org', 'admin');
    const res = await worker.fetch(
      new Request('https://steward.example.org/api/session', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.org' },
      }),
      workerEnv(),
      exec,
    );
    expect(res.status).toBe(401);
  });

  it('fails CLOSED when Access is not configured', async () => {
    await makeUser('admin@example.org', 'admin');
    const token = await mint('admin@example.org');
    const res = await call('/api/session', token, workerEnv({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }));
    expect(res.status).toBe(401);
  });
});

describe('a verified assertion is not by itself an account', () => {
  it('404s an authenticated email with no user row -- no auto-provisioning', async () => {
    // Widening an Access policy must not silently create staff accounts.
    const res = await call('/api/session', await mint('stranger@example.org'));
    expect(res.status).toBe(404);
  });

  it('404s a deactivated user', async () => {
    await makeUser('former@example.org', 'admin', 0);
    const res = await call('/api/session', await mint('former@example.org'));
    expect(res.status).toBe(404);
  });

  it('404s an applicant, who signs in by magic link rather than Access', async () => {
    // Applicants carry an organization_id, so insert one properly.
    const orgId = newId();
    const now = nowIso();
    await db
      .prepare(`INSERT INTO organizations (id, legal_name, status, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .bind(orgId, 'Invented Org', 'active', now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(newId(), 'applicant@example.org', 'applicant', orgId, 1, now, now)
      .run();

    const res = await call('/api/session', await mint('applicant@example.org'));
    expect(res.status).toBe(404);
  });

  it('gives the same 404 for every rejection, so it is not an email oracle', async () => {
    await makeUser('former@example.org', 'admin', 0);
    const a = await call('/api/session', await mint('stranger@example.org'));
    const b = await call('/api/session', await mint('former@example.org'));
    // Request ids differ by design; everything else must be byte-identical, or
    // the difference itself tells an attacker which emails are staff.
    const strip = (t: string) => t.replace(/"request_id":"[^"]*"/, '"request_id":"X"');
    expect(a.status).toBe(b.status);
    expect(strip(await a.text())).toBe(strip(await b.text()));
  });
});

describe('authenticated staff endpoints', () => {
  beforeEach(async () => {
    await makeUser('admin@example.org', 'admin');
  });

  it('returns the caller identity, and never an organization scope for staff', async () => {
    const res = await call('/api/session', await mint('admin@example.org'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.email).toBe('admin@example.org');
    expect(body.user.role).toBe('admin');
    expect(Object.keys(body.user)).toEqual(['email', 'role']);
  });

  it('lists programs', async () => {
    await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const res = await call('/api/programs', await mint('admin@example.org'));
    const body = (await res.json()) as { programs: { name: string }[] };
    expect(body.programs.map((p) => p.name)).toContain('Inspire Change');
  });

  it('lists cycles with deadlines rendered in Central time', async () => {
    await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const res = await call('/api/cycles', await mint('admin@example.org'));
    const body = (await res.json()) as { cycles: { closes_at: string; closes_at_display: string }[] };
    expect(body.cycles.length).toBeGreaterThan(0);
    // Stored UTC, displayed Central -- the March 2 UTC cutoff is March 1 locally.
    expect(body.cycles[0]!.closes_at).toContain('2026-03-02');
    expect(body.cycles[0]!.closes_at_display).toContain('March 1, 2026');
  });

  it('returns the form definition contract the applicant form will consume', async () => {
    const seeded = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const res = await call(
      `/api/forms/${seeded.formDefinitionIds.application}`,
      await mint('admin@example.org'),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      form: { status: string; sections: { section_key: string; fields: Record<string, unknown>[] }[] };
    };
    expect(body.form.status).toBe('published');
    expect(body.form.sections.map((s) => s.section_key)).toEqual([
      'contact', 'organization', 'request', 'narrative', 'uploads', 'confirmation', 'optin',
    ]);

    // Derived from the spec rather than hardcoded. The point of this assertion
    // is that the HTTP payload carries EVERY field the form defines -- a
    // literal count only re-asserts whatever the form happens to contain today
    // and has to be edited every time the copy changes.
    const appStage = INSPIRE_CHANGE.stages.find((st) => st.key === 'application')!;
    const expectedFields = appStage.form.sections.reduce((n, sec) => n + sec.fields.length, 0);
    const fields = body.form.sections.flatMap((s) => s.fields);
    expect(fields).toHaveLength(expectedFields);

    // The contract carries everything a renderer needs and nothing it does not.
    const amount = fields.find((f) => f.field_key === 'requested_amount')!;
    expect(amount.field_type).toBe('currency');
    expect(amount.is_required).toBe(true);
    expect((amount.validation as Record<string, unknown>).min_cents).toBe(1_000_000);

    // No applicant data of any kind is present.
    const json = JSON.stringify(body);
    expect(json).not.toContain('internal_notes');
    expect(json).not.toContain('decision_notes');
    expect(json).not.toContain('application_answers');
  });

  it('404s an unknown form id rather than erroring', async () => {
    const res = await call(`/api/forms/${newId()}`, await mint('admin@example.org'));
    expect(res.status).toBe(404);
  });

  it('404s an unknown API endpoint', async () => {
    const res = await call('/api/nope', await mint('admin@example.org'));
    expect(res.status).toBe(404);
  });

  it('lists form definitions as METADATA ONLY -- no sections, no fields', async () => {
    const seeded = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const res = await call('/api/forms', await mint('admin@example.org'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      forms: { id: string; program_name: string; stage_name: string | null; status: string }[];
    };
    const row = body.forms.find((f) => f.id === seeded.formDefinitionIds.application);
    expect(row).toBeTruthy();
    expect(row!.program_name).toBe('Inspire Change');
    expect(row!.status).toBe('published');

    // The list is a directory, not a payload. Fields belong to /api/forms/:id.
    const json = JSON.stringify(body);
    expect(json).not.toContain('field_key');
    expect(json).not.toContain('sections');
  });

  it('filters the form list by program', async () => {
    const seeded = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const mine = await call(
      `/api/forms?program_id=${seeded.programId}`,
      await mint('admin@example.org'),
    );
    const other = await call(`/api/forms?program_id=${newId()}`, await mint('admin@example.org'));
    expect(((await mine.json()) as { forms: unknown[] }).forms.length).toBeGreaterThan(0);
    expect(((await other.json()) as { forms: unknown[] }).forms).toHaveLength(0);
  });

  it('requires an Access assertion for the form list', async () => {
    const res = await call('/api/forms');
    expect(res.status).toBe(401);
  });
});

/**
 * The single-page app is served by the same Worker on the same hostname, so
 * Cloudflare Access sits in front of both. These tests pin the two things that
 * would otherwise rot silently: the shell carries the same security policy as
 * an API response, and the Worker does NOT become a catch-all that answers 200
 * to every mistyped URL.
 */
describe('serving the single-page app', () => {
  const SHELL = '<!doctype html><html data-surface="internal"><body><div id="root"></div></body></html>';

  function envWithAssets(): Env {
    return workerEnv({
      ASSETS: {
        async fetch(input: RequestInfo | URL) {
          const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(href).pathname === '/index.html') {
            return new Response(SHELL, { headers: { 'content-type': 'text/html' } });
          }
          return new Response('not found', { status: 404 });
        },
      } as unknown as Fetcher,
    } as Partial<Env>);
  }

  it('serves the shell on a deep link so the client router can take over', async () => {
    const res = await call('/forms/anything', undefined, envWithAssets());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('id="root"');
  });

  it('gives the shell the same security policy as an API response, bar the upload origin', async () => {
    const shell = await call('/forms/anything', undefined, envWithAssets());
    const apiRes = await call('/health', undefined, envWithAssets());
    for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cache-control']) {
      expect(shell.headers.get(h), `shell is missing ${h}`).toBe(apiRes.headers.get(h));
    }

    /*
     * The CSP differs in exactly THREE directives, deliberately, and in no
     * others. A CSP governs only the document it arrives with, so the shell is
     * the one that needs permissions and the API response is the one that
     * needs none. Asserting the two byte-identical is what this test used to
     * do, and it would force both of the faults below back.
     *
     *   connect-src: a file upload goes direct from the browser to R2 -- the
     *     Worker only authorizes it -- so the document has to reach the
     *     bucket. It could not, and every presigned PUT was refused by the
     *     browser before it was made: no request, no R2 error, nothing in any
     *     log.
     *
     *   script-src and frame-src: Turnstile loads a script from
     *     challenges.cloudflare.com and renders its challenge in an iframe
     *     from the same origin. Neither was allowed, so the widget never
     *     appeared on the sign-in page or the eligibility screen and no token
     *     was ever produced.
     *
     * Both are asserted in detail in test/csp.test.ts. What this test adds is
     * the count: nothing ELSE about the shell's policy may quietly differ.
     */
    const directives = (csp: string | null) => new Set((csp ?? '').split('; '));
    const shellCsp = directives(shell.headers.get('content-security-policy'));
    const apiCsp = directives(apiRes.headers.get('content-security-policy'));

    const onlyInShell = [...shellCsp].filter((d) => !apiCsp.has(d)).sort();
    const onlyInApi = [...apiCsp].filter((d) => !shellCsp.has(d)).sort();

    expect(onlyInApi).toEqual([
      "connect-src 'self'",
      "frame-src 'none'",
      "script-src 'self'",
    ]);
    expect(onlyInShell).toHaveLength(3);
    expect(onlyInShell.find((d) => d.startsWith('connect-src'))).toMatch(
      /^connect-src 'self' https:\/\/[^ ]+\.r2\.cloudflarestorage\.com$/,
    );
    expect(onlyInShell.find((d) => d.startsWith('script-src'))).toBe(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(onlyInShell.find((d) => d.startsWith('frame-src'))).toBe(
      'frame-src https://challenges.cloudflare.com',
    );
  });

  it('does NOT serve the shell for a path the app does not own', async () => {
    // A catch-all would answer 200 to every scanner and make a real 404
    // impossible to find in the logs.
    for (const path of ['/not-a-page', '/forms', '/forms/a/b', '/admin']) {
      const res = await call(path, undefined, envWithAssets());
      expect(res.status, `${path} should 404`).toBe(404);
    }
  });

  it('answers 405 with Allow for a non-GET request, not the shell and not a 404', async () => {
    // The route TABLE can tell "no such path" from "that path, another method";
    // the if-chain it replaced could not, so a POST to a GET-only route read to
    // the caller as though the endpoint did not exist. That sends the next
    // person debugging it looking for a routing bug that is not there.
    const res = await worker.fetch(
      new Request('https://steward.example.org/forms/anything', { method: 'POST' }),
      envWithAssets(),
      exec,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    // Still no HTML: the shell is not served to a write attempt.
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('404s rather than 500s when there is no asset binding at all', async () => {
    // The binding is optional in the Env type so the Worker runs with no build
    // output present. That path must degrade to a missing page, not to
    // something that reads like an outage.
    const bare = workerEnv();
    delete (bare as { ASSETS?: unknown }).ASSETS;
    const res = await call('/forms/anything', undefined, bare);
    expect(res.status).toBe(404);
  });

  it('falls back to / when the asset router redirects /index.html', async () => {
    // Pins the fallback: if the binding ever canonicalises /index.html the way
    // the public router does, deep links must keep working.
    const redirecting = workerEnv({
      ASSETS: {
        async fetch(input: RequestInfo | URL) {
          const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const path = new URL(href).pathname;
          if (path === '/index.html') return new Response(null, { status: 307, headers: { location: '/' } });
          if (path === '/') return new Response(SHELL, { headers: { 'content-type': 'text/html' } });
          return new Response('not found', { status: 404 });
        },
      } as unknown as Fetcher,
    } as Partial<Env>);
    const res = await call('/forms/anything', undefined, redirecting);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('404s when the asset store has no shell in it', async () => {
    const empty = workerEnv({
      ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } } as unknown as Fetcher,
    } as Partial<Env>);
    const res = await call('/forms/anything', undefined, empty);
    expect(res.status).toBe(404);
  });

  it('leaves the API alone: /api still 401s with no assertion, shell or not', async () => {
    const res = await call('/api/session', undefined, envWithAssets());
    expect(res.status).toBe(401);
  });
});

describe('the error boundary', () => {
  it('logs a failure to error_log and returns a request id the caller can quote', async () => {
    const res = await call('/api/session');
    const requestId = res.headers.get('x-request-id')!;
    const row = await db
      .prepare(`SELECT code, http_status, route FROM error_log WHERE request_id = ?`)
      .bind(requestId)
      .first<{ code: string; http_status: number; route: string }>();
    expect(row?.code).toBe('UNAUTHENTICATED');
    expect(row?.http_status).toBe(401);
    expect(row?.route).toBe('/api/session');
  });
});

// ---------------------------------------------------------------------------
describe('the report compliance desk, over HTTP', () => {
  /** A funded organization with one filed report, reachable by the staff API. */
  async function filedReport() {
    const adminCtx = ctxFor(adminSession());
    const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `rt-${newId().slice(0, 6)}` });
    const now = nowIso();

    const metricId = newId();
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,'individuals_served','How many individuals?','integer','people',1,10,
               'active',NULL,?,?)`,
    ).bind(metricId, p.programId, now, now).run();

    const form = await buildReportForm(db, adminCtx, { programId: p.programId });
    await db.prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
      .bind(now, form.formDefinitionId).run();

    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Route Harbor Trust', String(860000000 + (n += 1)), now, now).run();

    const awardId = newId();
    await db.prepare(
      `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
         status, source_system, source_reference, term_start, term_end, created_at, updated_at)
       VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    ).bind(awardId, orgId, p.programId, 2_500_000, now, `RT-${awardId.slice(0, 8)}`,
           '2025-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', now, now).run();
    await generateReportPeriods(db, adminCtx, awardId);

    const period = await db.prepare(`SELECT id FROM report_periods WHERE award_id=?`)
      .bind(awardId).first<{ id: string }>();

    const granteeId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
    ).bind(granteeId, `rt-g-${newId().slice(0, 6)}@example.org`, orgId, now, now).run();
    const grantee = {
      userId: granteeId, email: 'g@example.org', role: 'grantee' as const, organizationId: orgId,
    };
    await submitReport(db, ctxFor(grantee), grantee, period!.id, {
      narrative: 'We ran a summer reading programme.',
      metric_individuals_served: '412',
    });

    return { periodId: period!.id, orgId, programId: p.programId };
  }

  let n = 0;

  it('lists the portfolio for staff and refuses it to everyone else', async () => {
    const f = await filedReport();
    await makeUser('desk-admin@texans.com', 'admin');
    await makeUser('desk-reviewer@texans.com', 'reviewer');

    for (const email of ['desk-admin@texans.com', 'desk-reviewer@texans.com']) {
      const res = await call('/api/reports', await mint(email));
      expect(res.status, email).toBe(200);
      const body = await res.json<{ rows: { reportPeriodId: string }[] }>();
      expect(body.rows.map((r) => r.reportPeriodId)).toContain(f.periodId);
    }

    // No assertion at all.
    expect((await call('/api/reports')).status).toBe(401);
  });

  it('reads one report, with the money still in cents on the wire', async () => {
    const f = await filedReport();
    await makeUser('desk-read@texans.com', 'reviewer');
    const res = await call(`/api/reports/${f.periodId}`, await mint('desk-read@texans.com'));
    expect(res.status).toBe(200);
    const body = await res.json<{
      award: { awardedAmountCents: number };
      submissions: { answers: { fieldKey: string }[] }[];
    }>();
    expect(body.award.awardedAmountCents).toBe(2_500_000);
    expect(body.submissions[0]!.answers.map((a) => a.fieldKey)).toContain('narrative');
  });

  it('lets an admin accept, and refuses a reviewer', async () => {
    const f = await filedReport();
    await makeUser('desk-a@texans.com', 'admin');
    await makeUser('desk-r@texans.com', 'reviewer');

    // A reviewer can read the whole thing and decide none of it.
    const refused = await post(`/api/reports/${f.periodId}/accept`, await mint('desk-r@texans.com'), {});
    expect(refused.status).toBe(403);

    const ok = await post(`/api/reports/${f.periodId}/accept`, await mint('desk-a@texans.com'), {});
    expect(ok.status).toBe(200);
    expect(await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(f.periodId).first<{ status: string }>()).toMatchObject({ status: 'accepted' });
  });

  it('refuses a send-back with nothing useful in it', async () => {
    const f = await filedReport();
    await makeUser('desk-b@texans.com', 'admin');
    const token = await mint('desk-b@texans.com');

    const empty = await post(`/api/reports/${f.periodId}/revisions`, token, { feedback: '' });
    expect(empty.status).toBe(400);

    const real = await post(`/api/reports/${f.periodId}/revisions`, token, {
      feedback: 'Please break the spend out by site.',
    });
    expect(real.status).toBe(200);
    expect(await db.prepare(`SELECT status FROM report_periods WHERE id=?`)
      .bind(f.periodId).first<{ status: string }>())
      .toMatchObject({ status: 'revisions_requested' });
  });

  it('waives with a reason and refuses one without', async () => {
    const f = await filedReport();
    await makeUser('desk-c@texans.com', 'admin');
    const token = await mint('desk-c@texans.com');

    expect((await post(`/api/reports/${f.periodId}/waive`, token, { reason: '' })).status).toBe(400);
    const ok = await post(`/api/reports/${f.periodId}/waive`, token, {
      reason: 'Grant returned unspent in March.',
    });
    expect(ok.status).toBe(200);
  });

  it('404s a report period that does not exist', async () => {
    await makeUser('desk-d@texans.com', 'admin');
    const res = await call('/api/reports/nope', await mint('desk-d@texans.com'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('merging duplicate organizations, over HTTP', () => {
  async function twoRecordsOfOneNonprofit() {
    const now = nowIso();
    const ein = String(760000000 + (n += 1));
    const ids: string[] = [];
    for (const name of ['Harbor Trust', 'Harbor Trust Houston']) {
      const id = newId();
      await db.prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      ).bind(id, name, ein, now, now).run();
      ids.push(id);
    }
    return { survivor: ids[0]!, duplicate: ids[1]!, ein };
  }

  let n = 0;

  it('lists candidates for staff and refuses them to everyone else', async () => {
    const pair = await twoRecordsOfOneNonprofit();
    await makeUser('merge-reviewer@texans.com', 'reviewer');

    const res = await call('/api/organizations/duplicates', await mint('merge-reviewer@texans.com'));
    expect(res.status).toBe(200);
    const body = await res.json<{ groups: { key: string; organizations: { id: string }[] }[] }>();
    const found = body.groups.find((g) => g.key === pair.ein);
    expect(found!.organizations.map((o) => o.id).sort())
      .toEqual([pair.survivor, pair.duplicate].sort());

    expect((await call('/api/organizations/duplicates')).status).toBe(401);
  });

  it('previews a merge without doing it', async () => {
    const pair = await twoRecordsOfOneNonprofit();
    await makeUser('merge-preview@texans.com', 'reviewer');
    const res = await call(
      `/api/organizations/${pair.duplicate}/merge-preview?into=${pair.survivor}`,
      await mint('merge-preview@texans.com'),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; survivor: { id: string }; merged: { id: string } }>();
    expect(body.ok).toBe(true);
    expect(body.survivor.id).toBe(pair.survivor);
    expect(body.merged.id).toBe(pair.duplicate);

    // Nothing moved.
    const row = await db.prepare(`SELECT status FROM organizations WHERE id=?`)
      .bind(pair.duplicate).first<{ status: string }>();
    expect(row!.status).toBe('active');
  });

  it('refuses a preview that does not name a survivor', async () => {
    const pair = await twoRecordsOfOneNonprofit();
    await makeUser('merge-nosurv@texans.com', 'reviewer');
    const res = await call(
      `/api/organizations/${pair.duplicate}/merge-preview`,
      await mint('merge-nosurv@texans.com'),
    );
    expect(res.status).toBe(400);
  });

  it('lets an admin merge, and refuses a reviewer', async () => {
    const pair = await twoRecordsOfOneNonprofit();
    await makeUser('merge-admin@texans.com', 'admin');
    await makeUser('merge-rev2@texans.com', 'reviewer');

    const refused = await post(
      `/api/organizations/${pair.duplicate}/merge`,
      await mint('merge-rev2@texans.com'),
      { into: pair.survivor },
    );
    expect(refused.status).toBe(403);

    const ok = await post(
      `/api/organizations/${pair.duplicate}/merge`,
      await mint('merge-admin@texans.com'),
      { into: pair.survivor },
    );
    expect(ok.status).toBe(200);

    const row = await db.prepare(
      `SELECT status, merged_into_id FROM organizations WHERE id=?`,
    ).bind(pair.duplicate).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'merged', merged_into_id: pair.survivor });
  });

  it('refuses a merge that does not name a survivor', async () => {
    const pair = await twoRecordsOfOneNonprofit();
    await makeUser('merge-admin2@texans.com', 'admin');
    const res = await post(
      `/api/organizations/${pair.duplicate}/merge`,
      await mint('merge-admin2@texans.com'),
      {},
    );
    expect(res.status).toBe(400);
    const row = await db.prepare(`SELECT status FROM organizations WHERE id=?`)
      .bind(pair.duplicate).first<{ status: string }>();
    expect(row!.status).toBe('active');
  });
});
