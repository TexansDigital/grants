import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { isAcceptingApplications } from '../src/lib/eligibility';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

const ORIGIN = 'https://applications.example.org';
const env = () => ({ ...(testEnv as unknown as Env), APPLICANT_BASE_URL: ORIGIN });

const post = (path: string, body: unknown, e: Env = env()) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    e,
    {} as ExecutionContext,
  );

let n = 0;
const ein = () => String(300000000 + ++n);

/** A seeded program with its cycle actually open. */
async function openCycle() {
  const p = await seedProgram(db, ctxFor(adminSession()), {
    ...INSPIRE_CHANGE,
    slug: `elig-${++n}`,
  });
  const cycleId = Object.values(p.cycleIds)[0]!;
  await db
    .prepare(
      `UPDATE cycles SET status='open', opens_at=?, closes_at=? WHERE id=?`,
    )
    .bind(
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
      cycleId,
    )
    .run();
  return { cycleId, program: p };
}

const goodAnswers = (over: Record<string, unknown> = {}) => ({
  entity_type_confirmation: true,
  guidelines_attestation: true,
  authorization_attestation: true,
  organization_name: 'Bayou Reach Collective',
  ein: ein(),
  requested_amount: '$25,000',
  counties_served: ['harris'],
  contact_first_name: 'Alex',
  contact_last_name: 'Moreno',
  contact_email: `a${++n}@example.org`,
  ...over,
});

beforeEach(async () => {
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('passing eligibility', () => {
  it('creates the organization, contact, user, application and link', async () => {
    const { cycleId } = await openCycle();
    const answers = goodAnswers();
    const res = await post('/api/public/eligibility', { cycleId, answers });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe(String(answers.contact_email).toLowerCase());

    const user = await db.prepare(`SELECT id, organization_id FROM users WHERE email=?`)
      .bind(body.email).first<{ id: string; organization_id: string }>();
    expect(user).not.toBeNull();

    const app = await db
      .prepare(
        `SELECT status, submitted_at, organization_id, requested_amount_cents,
                ein_at_submit, submission_ip
           FROM applications WHERE organization_id=?`,
      )
      .bind(user!.organization_id)
      .first<Record<string, unknown>>();
    expect(app!.status).toBe('submitted');
    expect(app!.submitted_at).toBeTruthy();
    // Money is integer cents, promoted from the answer.
    expect(app!.requested_amount_cents).toBe(2_500_000);
    expect(app!.ein_at_submit).toBe(String(answers.ein));

    const token = await db
      .prepare(`SELECT id FROM login_tokens WHERE user_id=?`).bind(user!.id).first();
    expect(token).not.toBeNull();
  });

  it('stores the answers it was given', async () => {
    const { cycleId } = await openCycle();
    const answers = goodAnswers();
    await post('/api/public/eligibility', { cycleId, answers });
    const rows = await db
      .prepare(
        `SELECT field_key, value_text, value_int FROM application_answers
          ORDER BY field_key`,
      )
      .all<{ field_key: string; value_text: string | null; value_int: number | null }>();
    const byKey = new Map(rows.results.map((r) => [r.field_key, r]));
    expect(byKey.get('organization_name')!.value_text).toBe('Bayou Reach Collective');
    expect(byKey.get('requested_amount')!.value_int).toBe(2_500_000);
    expect(byKey.has('counties_served')).toBe(true);
  });

  it('audits the submission', async () => {
    const { cycleId } = await openCycle();
    await post('/api/public/eligibility', { cycleId, answers: goodAnswers() });
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action='application.submitted'`)
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('failing eligibility, before any narrative is written', () => {
  it('rejects an amount below the range', async () => {
    const { cycleId } = await openCycle();
    const res = await post('/api/public/eligibility', {
      cycleId, answers: goodAnswers({ requested_amount: '$7,500' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { context?: { fields?: { field: string }[] } } };
    const text = JSON.stringify(body);
    expect(text).toContain('requested_amount');
  });

  it('rejects an unchecked attestation', async () => {
    const { cycleId } = await openCycle();
    const res = await post('/api/public/eligibility', {
      cycleId, answers: goodAnswers({ entity_type_confirmation: false }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects no counties selected', async () => {
    const { cycleId } = await openCycle();
    const res = await post('/api/public/eligibility', {
      cycleId, answers: goodAnswers({ counties_served: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('creates nothing when validation fails', async () => {
    const { cycleId } = await openCycle();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`).first<{ n: number }>();
    await post('/api/public/eligibility', {
      cycleId, answers: goodAnswers({ requested_amount: '$1' }),
    });
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});

// ---------------------------------------------------------------------------
describe('the cycle has to be open', () => {
  it('refuses a draft cycle with a 404, not a 400', async () => {
    // An unauthenticated caller learns nothing about which cycles exist.
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE, slug: `closed-${++n}`,
    });
    const cycleId = Object.values(p.cycleIds)[0]!;
    const res = await post('/api/public/eligibility', { cycleId, answers: goodAnswers() });
    expect(res.status).toBe(404);
  });

  it('refuses an unknown cycle identically', async () => {
    const res = await post('/api/public/eligibility', { cycleId: newId(), answers: goodAnswers() });
    expect(res.status).toBe(404);
  });

  it('never serves an unpublished form to the public', async () => {
    // A published definition cannot return to draft -- the schema refuses it --
    // so the realistic shape is a NEW draft version sitting beside the live
    // one while an admin edits it. Serving that would let an unfinished form
    // collect real answers from real nonprofits.
    const { cycleId, program } = await openCycle();
    const eligId = program.formDefinitionIds.eligibility!;
    const now = nowIso();

    // Retire the live one and leave only a draft version 2 for the same stage.
    await db.prepare(`UPDATE form_definitions SET deleted_at=? WHERE id=?`).bind(now, eligId).run();
    await db
      .prepare(
        `INSERT INTO form_definitions (id, program_id, form_key, stage_id, kind, name,
           version, status, created_at, updated_at)
         SELECT ?, program_id, form_key, stage_id, kind, name, 2, 'draft', ?, ?
           FROM form_definitions WHERE id = ?`,
      )
      .bind(newId(), now, now, eligId)
      .run();

    const res = await post('/api/public/eligibility', { cycleId, answers: goodAnswers() });
    expect(res.status).toBe(404);
  });

  it('never falls through to the GATED stage when the first one is unavailable', async () => {
    // The full application is gated on eligibility. If the eligibility form is
    // missing, the answer is "not open" -- not "serve the thirty-field form to
    // an unauthenticated stranger", which is what dropping the gate filter did.
    const { cycleId, program } = await openCycle();
    await db.prepare(`UPDATE form_definitions SET deleted_at=? WHERE id=?`)
      .bind(nowIso(), program.formDefinitionIds.eligibility!).run();
    const res = await post('/api/public/eligibility', { cycleId, answers: goodAnswers() });
    expect(res.status).toBe(404);

    // And nothing was created on the way to that 404.
    const apps = await db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE cycle_id=?`)
      .bind(cycleId).first<{ n: number }>();
    expect(apps!.n).toBe(0);
  });

  it('checks the clock, not only the status flag', () => {
    const past = { status: 'open', opens_at: '2020-01-01T00:00:00.000Z', closes_at: '2020-02-01T00:00:00.000Z' };
    const future = { status: 'open', opens_at: '2099-01-01T00:00:00.000Z', closes_at: '2099-02-01T00:00:00.000Z' };
    const live = { status: 'open', opens_at: '2020-01-01T00:00:00.000Z', closes_at: '2099-01-01T00:00:00.000Z' };
    const now = new Date('2026-03-01T12:00:00.000Z');
    // A status left on 'open' past its close date is the likelier operational
    // mistake, and the one an applicant hits by accident on deadline night.
    expect(isAcceptingApplications(past, now)).toBe(false);
    expect(isAcceptingApplications(future, now)).toBe(false);
    expect(isAcceptingApplications(live, now)).toBe(true);
    expect(isAcceptingApplications({ ...live, status: 'closed' }, now)).toBe(false);
    expect(isAcceptingApplications({ ...live, closes_at: 'nonsense' }, now)).toBe(false);
    // Exact at the boundary: closes_at is exclusive.
    expect(isAcceptingApplications(live, new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
    expect(isAcceptingApplications(live, new Date('2098-12-31T23:59:59.999Z'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('identity conflicts are explained, not guessed', () => {
  it('refuses when the EIN matches more than one organization', async () => {
    const { cycleId } = await openCycle();
    const e = ein();
    const now = nowIso();
    for (const name of ['One', 'Two']) {
      await db.prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      ).bind(newId(), name, e, now, now).run();
    }
    const res = await post('/api/public/eligibility', { cycleId, answers: goodAnswers({ ein: e }) });
    // Indistinguishable from success. This endpoint is public: answering
    // differently would tell anyone holding a public EIN that the Foundation
    // has duplicate records for that nonprofit.
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain('more than one record');

    // The explanation went to the mailbox, which is where it belongs.
    const msg = await db.prepare(
      `SELECT template_key FROM email_messages WHERE idempotency_key LIKE 'sign_in_problem:%'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ template_key: string }>();
    expect(msg!.template_key).toBe('sign_in_problem');
  });

  it('says nothing to the caller about an email registered elsewhere', async () => {
    const { cycleId } = await openCycle();
    const first = goodAnswers();
    expect((await post('/api/public/eligibility', { cycleId, answers: first })).status).toBe(201);

    const second = goodAnswers({ contact_email: first.contact_email, ein: ein() });
    const res = await post('/api/public/eligibility', { cycleId, answers: second });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain('different organization');

    const msg = await db.prepare(
      `SELECT idempotency_key FROM email_messages
        WHERE idempotency_key LIKE 'sign_in_problem:other_organization:%' LIMIT 1`,
    ).first<{ idempotency_key: string }>();
    expect(msg, 'the mailbox owner is told; the caller is not').not.toBeNull();
  });

  it('says nothing to the caller about a staff address', async () => {
    // src/lib/auth.ts returns an identical 404 for three account states so an
    // attacker cannot learn which addresses are staff. This endpoint was
    // quietly undoing that with a distinguishable 409.
    const { cycleId } = await openCycle();
    const staff = `admin-${newId().slice(0, 6)}@example-foundation.org`;
    const now = nowIso();
    await db.prepare(
      `INSERT INTO users (id, email, role, is_active, created_at, updated_at)
       VALUES (?,?,'admin',1,?,?)`,
    ).bind(newId(), staff, now, now).run();

    const res = await post('/api/public/eligibility', {
      cycleId, answers: goodAnswers({ contact_email: staff }),
    });
    const body = JSON.stringify(await res.json());
    expect(res.status).toBe(201);
    expect(body).not.toMatch(/staff|cannot be used/i);

    const msg = await db.prepare(
      `SELECT idempotency_key FROM email_messages
        WHERE idempotency_key LIKE 'sign_in_problem:staff_account:%' LIMIT 1`,
    ).first<{ idempotency_key: string }>();
    expect(msg).not.toBeNull();
  });

  it('answers identically whether or not the organization already applied', async () => {
    // "You have already completed this step" answered "has this nonprofit
    // applied?" for anyone holding a public EIN.
    const { cycleId } = await openCycle();
    const a = goodAnswers();
    const first = await post('/api/public/eligibility', { cycleId, answers: a });
    const second = await post('/api/public/eligibility', { cycleId, answers: { ...a } });

    expect(first.status).toBe(second.status);
    expect(await first.json()).toEqual(await second.json());
  });

  it('lets the same person from the same organization submit again', async () => {
    const { cycleId } = await openCycle();
    const a = goodAnswers();
    expect((await post('/api/public/eligibility', { cycleId, answers: a })).status).toBe(201);
    const again = await post('/api/public/eligibility', { cycleId, answers: { ...a } });
    expect(again.status).toBe(201);
    const orgs = await db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE ein=?`)
      .bind(String(a.ein)).first<{ n: number }>();
    expect(orgs!.n).toBe(1);
  });
});
