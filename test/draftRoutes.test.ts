import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

const ORIGIN = 'https://applications.example.org';
const env = () => ({ ...(testEnv as unknown as Env), APPLICANT_BASE_URL: ORIGIN });

let n = 0;
const ein = () => String(400000000 + ++n);

async function call(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.10' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env(),
    {} as ExecutionContext,
  );
}

/**
 * A signed-in applicant who has passed eligibility for an open cycle -- built
 * through the REAL public route, so the gate is satisfied the way it will be
 * in production rather than by inserting a row that looks right.
 */
async function signedInApplicant(over: { passEligibility?: boolean } = {}) {
  const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `d-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  await db
    .prepare(`UPDATE cycles SET status='open', opens_at=?, closes_at=? WHERE id=?`)
    .bind(
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
      cycleId,
    )
    .run();

  const email = `d${n}-${crypto.randomUUID().slice(0, 6)}@example.org`;
  const orgEin = ein();

  if (over.passEligibility !== false) {
    const res = await call('/api/public/eligibility', {
      method: 'POST',
      body: {
        cycleId,
        answers: {
          entity_type_confirmation: true,
          guidelines_attestation: true,
          authorization_attestation: true,
          organization_name: 'Bayou Reach Collective',
          ein: orgEin,
          requested_amount: '$25,000',
          counties_served: ['harris'],
          contact_first_name: 'Alex',
          contact_last_name: 'Moreno',
          contact_email: email,
        },
      },
    });
    expect(res.status).toBe(201);
  } else {
    // An account with no eligibility application at all.
    const orgId = newId();
    const now = nowIso();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Ungated Org', orgEin, now, now).run();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(newId(), email, orgId, now, now).run();
  }

  const user = await db.prepare(`SELECT id, organization_id FROM users WHERE email=?`)
    .bind(email).first<{ id: string; organization_id: string }>();
  const { sessionToken } = await createSession(env(), user!.id);
  return {
    cycleId, email, userId: user!.id, organizationId: user!.organization_id,
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
  };
}

/** A staff user id, for the CHECK that a decision names who made it. */
async function decider(): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
  ).bind(id, `admin${++n}-${crypto.randomUUID().slice(0, 6)}@example.org`, now, now).run();
  return id;
}

beforeEach(async () => {
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('starting the full application', () => {
  it('creates a draft at the gated stage once eligibility is passed', async () => {
    const a = await signedInApplicant();
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application: { id: string; stage_key: string } };
    expect(body.application.stage_key).toBe('application');

    const row = await db.prepare(`SELECT status, organization_id FROM applications WHERE id=?`)
      .bind(body.application.id).first<{ status: string; organization_id: string }>();
    expect(row!.status).toBe('draft');
    expect(row!.organization_id).toBe(a.organizationId);
  });

  it('audits the creation', async () => {
    const a = await signedInApplicant();
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    const { application } = (await res.json()) as { application: { id: string } };
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action='application.created' AND entity_id=?`)
      .bind(application.id).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it('starts at eligibility when that stage has not been done', async () => {
    const a = await signedInApplicant({ passEligibility: false });
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    // The FIRST unstarted stage, which is eligibility -- ungated and
    // legitimately startable. This does NOT exercise the gate; see below.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application: { stage_key: string } };
    expect(body.application.stage_key).toBe('eligibility');
  });

  it('REFUSES the gated stage when the prior stage was declined', async () => {
    // The gate firing, isolated. An eligibility application exists, so the
    // walk reaches the gated stage -- and its status must decide whether that
    // stage opens. Without this, "gated" quietly means "anyone who submitted",
    // and a declined organization walks into the thirty-field form.
    const a = await signedInApplicant();
    await db
      // A decision needs BOTH a time and a decider, by CHECK -- the schema will
      // not record who declined somebody as unknown.
      .prepare(
        `UPDATE applications SET status='declined', decided_at=?, decided_by=?
          WHERE organization_id=?`,
      )
      .bind(nowIso(), await decider(), a.organizationId)
      .run();

    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('previous step');

    // And nothing was created on the way to that refusal.
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM applications WHERE organization_id=?`)
      .bind(a.organizationId).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it('REFUSES the gated stage when the prior stage is still a draft', async () => {
    const a = await signedInApplicant();
    await db
      .prepare(`UPDATE applications SET status='draft', submitted_at=NULL WHERE organization_id=?`)
      .bind(a.organizationId)
      .run();
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    expect(res.status).toBe(403);
  });

  it('never starts an application against an UNPUBLISHED form', async () => {
    // A draft definition is work in progress. Starting a real application
    // against one would collect answers into a form still being edited, and
    // pin the application to a version that may never be published.
    const a = await signedInApplicant();
    const stage = await db
      .prepare(
        `SELECT ps.id AS stage_id, fd.id AS fd_id
           FROM program_stages ps
           JOIN form_definitions fd ON fd.stage_id = ps.id AND fd.deleted_at IS NULL
          WHERE ps.stage_key = 'application' AND ps.program_id =
                (SELECT program_id FROM cycles WHERE id = ?)`,
      )
      .bind(a.cycleId)
      .first<{ stage_id: string; fd_id: string }>();

    const now = nowIso();
    await db.prepare(`UPDATE form_definitions SET deleted_at=? WHERE id=?`)
      .bind(now, stage!.fd_id).run();
    await db
      .prepare(
        `INSERT INTO form_definitions (id, program_id, form_key, stage_id, kind, name,
           version, status, created_at, updated_at)
         SELECT ?, program_id, form_key, stage_id, kind, name, 2, 'draft', ?, ?
           FROM form_definitions WHERE id = ?`,
      )
      .bind(newId(), now, now, stage!.fd_id)
      .run();

    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    // The stage is invisible without a published form, so there is nothing
    // left to start -- NOT a draft against the unpublished one.
    expect(res.status).toBe(409);
  });

  it('refuses a cycle that is not open', async () => {
    const a = await signedInApplicant();
    await db.prepare(`UPDATE cycles SET status='closed' WHERE id=?`).bind(a.cycleId).run();
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    expect(res.status).toBe(404);
  });

  it('refuses without a session', async () => {
    const a = await signedInApplicant();
    expect((await call('/api/applications', { method: 'POST', body: { cycleId: a.cycleId } })).status)
      .toBe(401);
  });

  it('refuses to start the same stage twice', async () => {
    const a = await signedInApplicant();
    expect((await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    })).status).toBe(201);
    const again = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('the draft survives changing device', () => {
  async function startedDraft() {
    const a = await signedInApplicant();
    const res = await call('/api/applications', {
      method: 'POST', cookie: a.cookie, body: { cycleId: a.cycleId },
    });
    const { application } = (await res.json()) as { application: { id: string } };
    return { ...a, applicationId: application.id };
  }

  it('reads back what a different device saved', async () => {
    // The finding this whole phase exists for: a phone at 9pm and a laptop the
    // next morning must be the same application.
    const a = await startedDraft();

    const saved = await call(`/api/applications/${a.applicationId}/draft`, {
      method: 'PATCH', cookie: a.cookie,
      body: { answers: { project_title: 'Literacy Lab', advancing_opportunity: 'Serving students.' } },
    });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { savedAt: string }).savedAt).toBeTruthy();

    // A DIFFERENT session for the same user, as a second device would have.
    const { sessionToken } = await createSession(env(), a.userId);
    const read = await call(`/api/applications/${a.applicationId}/draft`, {
      cookie: `${SESSION_COOKIE}=${sessionToken}`,
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { answers: Record<string, unknown>; form: { id: string } };
    expect(body.answers.project_title).toBe('Literacy Lab');
    expect(body.answers.advancing_opportunity).toBe('Serving students.');
    expect(body.form.id).toBeTruthy();
  });

  it('merges saves of different sections rather than replacing the draft', async () => {
    const a = await startedDraft();
    await call(`/api/applications/${a.applicationId}/draft`, {
      method: 'PATCH', cookie: a.cookie, body: { answers: { project_title: 'Literacy Lab' } },
    });
    await call(`/api/applications/${a.applicationId}/draft`, {
      method: 'PATCH', cookie: a.cookie, body: { answers: { community_need: 'Reading trails.' } },
    });
    const read = await call(`/api/applications/${a.applicationId}/draft`, { cookie: a.cookie });
    const body = (await read.json()) as { answers: Record<string, unknown> };
    // The second save must not have wiped the first.
    expect(body.answers.project_title).toBe('Literacy Lab');
    expect(body.answers.community_need).toBe('Reading trails.');
  });

  it('cannot be given an answer belonging to another form definition', async () => {
    // readDraft skips an answer whose field_key is not in the definition. That
    // skip turns out to be unreachable: form_fields has no deleted_at, so a
    // published definition's field list never shrinks, and the database
    // refuses an answer pointing at another definition's field outright. The
    // schema property is what gets asserted; the skip stays as one line of
    // defence in depth and is honestly untestable.
    const a = await startedDraft();
    const foreign = await db
      .prepare(`SELECT id FROM form_fields WHERE field_key = 'entity_type_confirmation' LIMIT 1`)
      .first<{ id: string }>();

    await expect(
      db
        .prepare(
          `INSERT INTO application_answers (id, application_id, form_field_id, field_key,
             label_at_answer, field_type, value_text, answered_at)
           VALUES (?,?,?,?,?,'checkbox_attestation','true',?)`,
        )
        .bind(newId(), a.applicationId, foreign!.id, 'entity_type_confirmation', 'x', nowIso())
        .run(),
    ).rejects.toThrow(/different form definition/);
  });

  it('returns typed values, not everything as a string', async () => {
    const a = await startedDraft();
    await call(`/api/applications/${a.applicationId}/draft`, {
      method: 'PATCH', cookie: a.cookie,
      body: { answers: { requested_amount: '$25,000', counties_served: ['harris', 'waller'] } },
    });
    const body = (await (await call(`/api/applications/${a.applicationId}/draft`, { cookie: a.cookie })).json()) as
      { answers: Record<string, unknown> };
    // Money is integer cents all the way to the edge.
    expect(body.answers.requested_amount).toBe(2_500_000);
    expect(body.answers.counties_served).toEqual(['harris', 'waller']);
  });
});

// ---------------------------------------------------------------------------
describe('scoping: another organization does not exist', () => {
  it('404s a read of another organization’s draft', async () => {
    const mine = await signedInApplicant();
    const theirs = await signedInApplicant();
    const created = await call('/api/applications', {
      method: 'POST', cookie: theirs.cookie, body: { cycleId: theirs.cycleId },
    });
    const { application } = (await created.json()) as { application: { id: string } };

    const res = await call(`/api/applications/${application.id}/draft`, { cookie: mine.cookie });
    // 404, not 403. A 403 would confirm somebody else's application is real.
    expect(res.status).toBe(404);
  });

  it('404s an autosave into another organization’s draft, and writes nothing', async () => {
    const mine = await signedInApplicant();
    const theirs = await signedInApplicant();
    const created = await call('/api/applications', {
      method: 'POST', cookie: theirs.cookie, body: { cycleId: theirs.cycleId },
    });
    const { application } = (await created.json()) as { application: { id: string } };

    const res = await call(`/api/applications/${application.id}/draft`, {
      method: 'PATCH', cookie: mine.cookie, body: { answers: { project_title: 'Injected' } },
    });
    expect(res.status).toBe(404);

    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM application_answers WHERE application_id=?`)
      .bind(application.id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('404s an application id that does not exist at all, identically', async () => {
    const mine = await signedInApplicant();
    expect((await call(`/api/applications/${newId()}/draft`, { cookie: mine.cookie })).status).toBe(404);
  });

  it('refuses to autosave over a submitted application', async () => {
    const mine = await signedInApplicant();
    const app = await db
      .prepare(`SELECT id FROM applications WHERE organization_id=? LIMIT 1`)
      .bind(mine.organizationId).first<{ id: string }>();
    // The eligibility application is already submitted.
    const res = await call(`/api/applications/${app!.id}/draft`, {
      method: 'PATCH', cookie: mine.cookie, body: { answers: { organization_name: 'Renamed' } },
    });
    expect(res.status).toBe(409);
  });
});
