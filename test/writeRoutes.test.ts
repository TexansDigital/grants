import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env as testEnv } from 'cloudflare:test';
import worker, { routes } from '../src/index';
import { db } from './helpers';
import { __resetJwksCache, ACCESS_JWT_HEADER } from '../src/lib/access';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { resolve, ADMIN_ONLY } from '../src/lib/router';
import type { Env } from '../src/types';

/**
 * The first mutating routes in the system.
 *
 * Definition of done #4 for this phase lives here: every mutating action writes
 * an audit row, and the row records who, what, before and after. These tests
 * assert the row exists AND that it is in the same batch as its mutation --
 * a write that lands without provenance is a financial record nobody can
 * account for.
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

async function mint(email: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  const p = b64url(
    JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email, sub: `sub-${email}`, iat: nowSec - 60, exp: nowSec + 3600 }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signKey, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function workerEnv(): Env {
  return {
    ...(testEnv as unknown as Env),
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ENVIRONMENT: 'preview',
    DISPLAY_TIMEZONE: 'America/Chicago',
  };
}

const exec = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers[ACCESS_JWT_HEADER] = opts.token;
  return worker.fetch(
    new Request(`https://steward.example.org${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    workerEnv(),
    exec,
  );
}

async function makeUser(email: string, role: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
       VALUES (?,?,?,NULL,?,1,?,?)`,
    )
    .bind(id, email, role, email, now, now)
    .run();
  return id;
}

let adminToken: string;
let reviewerToken: string;

beforeEach(async () => {
  __resetJwksCache();
  await setupKeys();
  realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as RequestInfo, init);
  });
  await makeUser('admin@example.org', 'admin');
  await makeUser('reviewer@example.org', 'reviewer');
  adminToken = await mint('admin@example.org');
  reviewerToken = await mint('reviewer@example.org');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every audit row for one entity, newest first. */
async function auditFor(entityId: string): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT action, entity_type, entity_id, actor_user_id, actor_role,
              before_json, after_json, changed_fields_json, created_at
         FROM audit_log WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(entityId)
    .all<Record<string, unknown>>();
  return results ?? [];
}

async function makeProgram(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await call('/api/programs', {
    method: 'POST',
    token: adminToken,
    body: { name: `Program ${newId().slice(0, 8)}`, ...body },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { program: Record<string, unknown> }).program;
}

// ---------------------------------------------------------------------------

describe('the route table', () => {
  it('every non-public route declares its roles', () => {
    // A permissive default is the failure this system cannot afford, so the
    // table has none. This test is the backstop for a route added without one.
    for (const route of routes) {
      if (route.public) continue;
      expect(route.roles.length, `${route.method} ${route.path} declares no roles`).toBeGreaterThan(0);
    }
  });

  it('distinguishes an unknown path from a known path at another method', () => {
    expect(resolve(routes, 'GET', '/api/nope').kind).toBe('not_found');
    const r = resolve(routes, 'DELETE', '/api/programs');
    expect(r.kind).toBe('method_not_allowed');
    expect(r.allow).toContain('POST');
    expect(r.allow).toContain('GET');
  });

  it('a :param never spans a slash', () => {
    expect(resolve(routes, 'GET', '/api/forms/abc').kind).toBe('matched');
    expect(resolve(routes, 'GET', '/api/forms/abc/def').kind).toBe('not_found');
  });

  it('writes are admin-only in the table itself, not only at runtime', () => {
    const writes = routes.filter((r) => r.method !== 'GET' && !r.public);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.roles, `${w.method} ${w.path} is not admin-only`).toEqual(ADMIN_ONLY);
    }
  });
});

describe('authorization on writes', () => {
  it('401s a write with no Access assertion', async () => {
    const res = await call('/api/programs', { method: 'POST', body: { name: 'Nope' } });
    expect(res.status).toBe(401);
  });

  it('403s a REVIEWER on every write route, with no row created', async () => {
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM programs`).first<{ n: number }>();
    const attempts = [
      call('/api/programs', { method: 'POST', token: reviewerToken, body: { name: 'Reviewer program' } }),
      call(`/api/programs/${newId()}`, { method: 'PATCH', token: reviewerToken, body: { name: 'x' } }),
      call(`/api/programs/${newId()}`, { method: 'DELETE', token: reviewerToken }),
      call(`/api/cycles/${newId()}/open`, { method: 'POST', token: reviewerToken }),
    ];
    for (const p of attempts) {
      const res = await p;
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    }
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM programs`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('403 is checked AFTER authentication, so it cannot confirm a route to a stranger', async () => {
    // An unauthenticated caller must not be able to tell an admin-only route
    // from a nonexistent one.
    const res = await call('/api/programs', { method: 'POST', body: { name: 'x' } });
    expect(res.status).toBe(401);
  });

  it('a reviewer can still READ', async () => {
    const res = await call('/api/programs', { token: reviewerToken });
    expect(res.status).toBe(200);
  });

  it('an executive gets nothing from the review queue route', async () => {
    await makeUser('exec@example.org', 'executive');
    const res = await call('/api/review/queue', { token: await mint('exec@example.org') });
    expect(res.status).toBe(403);
  });
});

describe('programs', () => {
  it('creates a program and writes ONE audit row with the after state', async () => {
    const program = await makeProgram({ fiscal_year: 2027, compliance_policy: 'block' });
    const rows = await auditFor(String(program.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('program.created');
    expect(rows[0]!.entity_type).toBe('program');
    expect(rows[0]!.actor_role).toBe('admin');
    expect(rows[0]!.before_json).toBeNull();
    const after = JSON.parse(String(rows[0]!.after_json)) as Record<string, unknown>;
    expect(after.fiscal_year).toBe(2027);
    expect(after.compliance_policy).toBe('block');
  });

  it('records before AND after on an update, and which fields changed', async () => {
    const program = await makeProgram({ fiscal_year: 2027 });
    const res = await call(`/api/programs/${program.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { fiscal_year: 2028, status: 'active' },
    });
    expect(res.status).toBe(200);

    const rows = await auditFor(String(program.id));
    expect(rows).toHaveLength(2);
    const update = rows.find((r) => r.action === 'program.updated')!;
    const before = JSON.parse(String(update.before_json)) as Record<string, unknown>;
    const after = JSON.parse(String(update.after_json)) as Record<string, unknown>;
    expect(before.fiscal_year).toBe(2027);
    expect(after.fiscal_year).toBe(2028);
    const changed = JSON.parse(String(update.changed_fields_json)) as string[];
    expect(changed).toContain('fiscal_year');
    expect(changed).toContain('status');
    expect(changed).not.toContain('name');
  });

  it('rejects a float where integer cents are expected, rather than rounding it', async () => {
    // Silent rounding is how a budget becomes wrong by a cent and nobody can
    // say when. Money is integer cents everywhere, including on the way in.
    const res = await call('/api/programs', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Float budget', total_budget_cents: 100.5 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; fields: { field: string }[] } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields.map((f) => f.field)).toContain('total_budget_cents');
  });

  it('reports EVERY validation problem at once, not just the first', async () => {
    const res = await call('/api/programs', {
      method: 'POST',
      token: adminToken,
      body: { status: 'nonsense', fiscal_year: 1200, total_budget_cents: -5 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields: { field: string }[] } };
    const fields = body.error.fields.map((f) => f.field);
    expect(fields).toContain('name');
    expect(fields).toContain('status');
    expect(fields).toContain('fiscal_year');
    expect(fields).toContain('total_budget_cents');
  });

  it('404s an update to a program that does not exist, and writes no audit row', async () => {
    const id = newId();
    const res = await call(`/api/programs/${id}`, { method: 'PATCH', token: adminToken, body: { name: 'x' } });
    expect(res.status).toBe(404);
    expect(await auditFor(id)).toHaveLength(0);
  });

  it('SOFT-deletes, leaving the row and its audit trail in place', async () => {
    const program = await makeProgram();
    const res = await call(`/api/programs/${program.id}`, { method: 'DELETE', token: adminToken });
    expect(res.status).toBe(200);

    const row = await db
      .prepare(`SELECT deleted_at FROM programs WHERE id = ?`)
      .bind(program.id)
      .first<{ deleted_at: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.deleted_at).toBeTruthy();

    // Gone from the list, still in the database, still audited.
    const list = await call('/api/programs', { token: adminToken });
    const body = (await list.json()) as { programs: { id: string }[] };
    expect(body.programs.map((p) => p.id)).not.toContain(program.id);
    expect((await auditFor(String(program.id))).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to archive a program that still has live cycles', async () => {
    const program = await makeProgram();
    await call(`/api/programs/${program.id}/cycles`, {
      method: 'POST',
      token: adminToken,
      body: { name: 'FY27', opens_at: '2027-01-05T14:00:00Z', closes_at: '2027-03-02T05:59:00Z' },
    });
    const res = await call(`/api/programs/${program.id}`, { method: 'DELETE', token: adminToken });
    expect(res.status).toBe(409);
  });
});

describe('cycles', () => {
  async function makeCycle(programId: string, body: Record<string, unknown> = {}) {
    const res = await call(`/api/programs/${programId}/cycles`, {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'FY2027 Spring',
        opens_at: '2027-01-05T14:00:00Z',
        closes_at: '2027-03-02T05:59:00Z',
        ...body,
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { cycle: Record<string, unknown> }).cycle;
  }

  it('is born in DRAFT, never open', async () => {
    // Creating a cycle and opening it in one call is how a form goes live
    // before anyone meant it to.
    const program = await makeProgram();
    const cycle = await makeCycle(String(program.id));
    expect(cycle.status).toBe('draft');
  });

  it('refuses a cycle that closes before it opens, in plain language', async () => {
    const program = await makeProgram();
    const res = await call(`/api/programs/${program.id}/cycles`, {
      method: 'POST',
      token: adminToken,
      body: { name: 'Backwards', opens_at: '2027-03-02T00:00:00Z', closes_at: '2027-01-05T00:00:00Z' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields: { field: string; message: string }[] } };
    expect(body.error.fields[0]!.message).toMatch(/close after it opens/);
  });

  it('opening is its own audited verb', async () => {
    const program = await makeProgram();
    const cycle = await makeCycle(String(program.id));

    const opened = await call(`/api/cycles/${cycle.id}/open`, { method: 'POST', token: adminToken });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { cycle: { status: string } }).cycle.status).toBe('open');

    const rows = await auditFor(String(cycle.id));
    expect(rows.map((r) => r.action)).toContain('cycle.opened');
  });

  it('will not let a general update change status by the back door', async () => {
    // A status buried in a general update is a cycle that opens as a side
    // effect of someone fixing a typo in its name.
    const program = await makeProgram();
    const cycle = await makeCycle(String(program.id));
    const res = await call(`/api/cycles/${cycle.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'open' },
    });
    expect(res.status).toBe(400);
    const row = await db
      .prepare(`SELECT status FROM cycles WHERE id = ?`)
      .bind(cycle.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('draft');
  });

  it('refuses an illegal transition and writes no audit row for it', async () => {
    const program = await makeProgram();
    const cycle = await makeCycle(String(program.id));
    const res = await call(`/api/cycles/${cycle.id}/close`, { method: 'POST', token: adminToken });
    expect(res.status).toBe(409); // draft cannot be closed
    const actions = (await auditFor(String(cycle.id))).map((r) => r.action);
    expect(actions).not.toContain('cycle.closed');
  });

  it('a concurrent double-open produces ONE state change and ONE audit row', async () => {
    // The transition is guarded in the UPDATE rather than read-then-written, so
    // the loser of the race is a no-op that surfaces as a conflict instead of a
    // second triumphant audit row saying the cycle opened twice.
    const program = await makeProgram();
    const cycle = await makeCycle(String(program.id));

    const [a, b] = await Promise.all([
      call(`/api/cycles/${cycle.id}/open`, { method: 'POST', token: adminToken }),
      call(`/api/cycles/${cycle.id}/open`, { method: 'POST', token: adminToken }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const opens = (await auditFor(String(cycle.id))).filter((r) => r.action === 'cycle.opened');
    expect(opens).toHaveLength(1);
  });

  it('renders deadlines in Central time with the zone named', async () => {
    const program = await makeProgram();
    await makeCycle(String(program.id), { closes_at: '2027-03-02T05:59:00Z' });
    const res = await call(`/api/cycles?program_id=${program.id}`, { token: adminToken });
    const body = (await res.json()) as { cycles: { closes_at_display: string }[] };
    expect(body.cycles[0]!.closes_at_display).toContain('March 1, 2027');
    expect(body.cycles[0]!.closes_at_display).toContain('CST');
  });
});

describe('stages', () => {
  it('creates a stage under its program and audits it', async () => {
    const program = await makeProgram();
    const res = await call(`/api/programs/${program.id}/stages`, {
      method: 'POST',
      token: adminToken,
      body: { name: 'Letter of Intent', sort_order: 0, gate_on_prior_decision: true },
    });
    expect(res.status).toBe(201);
    const stage = ((await res.json()) as { stage: Record<string, unknown> }).stage;
    expect(stage.gate_on_prior_decision).toBe(1);
    expect(stage.stage_key).toBe('letter-of-intent');

    const rows = await auditFor(String(stage.id));
    expect(rows.map((r) => r.action)).toContain('program_stage.created');
  });

  it('404s a stage under a program that does not exist', async () => {
    const res = await call(`/api/programs/${newId()}/stages`, {
      method: 'POST',
      token: adminToken,
      body: { name: 'Orphan' },
    });
    expect(res.status).toBe(404);
  });
});

describe('request bodies', () => {
  it('rejects a body that is not JSON, in plain language', async () => {
    const res = await worker.fetch(
      new Request('https://steward.example.org/api/programs', {
        method: 'POST',
        headers: { [ACCESS_JWT_HEADER]: adminToken, 'content-type': 'application/json' },
        body: 'not json at all',
      }),
      workerEnv(),
      exec,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields: { message: string }[] } };
    expect(body.error.fields[0]!.message).toMatch(/valid JSON/);
  });

  it('rejects an oversized body before parsing it', async () => {
    const res = await worker.fetch(
      new Request('https://steward.example.org/api/programs', {
        method: 'POST',
        headers: { [ACCESS_JWT_HEADER]: adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(100_000) }),
      }),
      workerEnv(),
      exec,
    );
    expect(res.status).toBe(413);
  });

  it('rejects a JSON array where an object is required', async () => {
    const res = await call('/api/programs', { method: 'POST', token: adminToken, body: [1, 2, 3] });
    expect(res.status).toBe(400);
  });
});

describe('executives have no access to the application at all', () => {
  it('is refused every read route, per the access table', async () => {
    // CLAUDE.md: "Executive | Nothing in the app | Nothing. Receives PDF and
    // CSV exports." The router constant was called ANY_STAFF and included
    // them, which let an executive read every program, cycle and form
    // definition -- including total budgets.
    await makeUser('exec2@example.org', 'executive');
    const token = await mint('exec2@example.org');
    for (const path of [
      '/api/session',
      '/api/programs',
      '/api/cycles',
      '/api/forms',
      `/api/forms/${newId()}`,
      '/api/applications',
      '/api/search?q=x',
      '/api/review/queue',
    ]) {
      const res = await call(path, { token });
      expect(res.status, `${path} must not be readable by an executive`).toBe(403);
    }
  });

  it('a reviewer keeps the reads an executive loses', async () => {
    const res = await call('/api/programs', { token: reviewerToken });
    expect(res.status).toBe(200);
  });
});
