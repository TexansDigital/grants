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
      'eligibility', 'contact', 'organization', 'request', 'narrative', 'uploads', 'optin',
    ]);

    const fields = body.form.sections.flatMap((s) => s.fields);
    expect(fields).toHaveLength(34);

    // The contract carries everything a renderer needs and nothing it does not.
    const amount = fields.find((f) => f.field_key === 'requested_amount')!;
    expect(amount.field_type).toBe('currency');
    expect(amount.is_required).toBe(true);
    expect((amount.validation as Record<string, unknown>).min_cents).toBe(500_000);

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
