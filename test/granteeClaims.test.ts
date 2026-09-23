import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { approveClaim, rejectClaim, listClaims, readClaim } from '../src/lib/granteeClaims';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Session } from '../src/types';

/**
 * Enrolling a past grant recipient.
 *
 * THE PROPERTY EVERYTHING ELSE SERVES: filing a claim grants nothing. The
 * public endpoint records a request and answers identically whether or not a
 * matching award exists, because anything else turns it into an oracle --
 * feed it EINs, learn which nonprofits the Foundation has funded, one request
 * at a time. Access happens when a person approves, and only then.
 */

const ORIGIN = 'https://applications.example.org';
const env = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  // No secret key, and the reviewed opt-out set: verifyTurnstile fails closed
  // without it, which is the posture the public form ships with.
  TURNSTILE_OPTIONAL: '1',
  ...over,
});

const post = (path: string, body: unknown, e: Env = env(), cookie?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': `203.0.113.${1 + Math.floor(Math.random() * 250)}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    e,
    {} as ExecutionContext,
  );

let n = 0;
const claimBody = (over: Record<string, unknown> = {}) => ({
  organizationName: 'Invented Bayou Alliance',
  firstName: 'Alex',
  lastName: 'Moreno',
  email: `claimer-${++n}-${crypto.randomUUID().slice(0, 6)}@example-invented.org`,
  grantYear: 2024,
  grantDescription: 'The after-school reading programme.',
  ...over,
});

/** A funded organization, the way an imported historical award looks. */
async function fundedOrg(opts: { ein?: string; termed?: boolean } = {}) {
  const adminCtx = ctxFor(adminSession());
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `claim-${++n}` });
  const now = nowIso();
  const orgId = newId();
  const ein = opts.ein ?? String(960000000 + n);
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?, 'active', ?, ?)`,
  ).bind(orgId, `Invented Bayou Alliance ${n}`, ein, now, now).run();

  const awardId = newId();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, term_start, term_end, created_at, updated_at)
     VALUES (?,?,?,?,?, 'active', 'spreadsheet', ?, ?, ?, ?, ?)`,
  ).bind(
    awardId, orgId, p.programId, 2_500_000, now, `HIST-${n}`,
    opts.termed === false ? null : '2024-01-01T00:00:00.000Z',
    opts.termed === false ? null : '2024-12-31T00:00:00.000Z',
    now, now,
  ).run();
  return { orgId, awardId, programId: p.programId, ein };
}

/**
 * An admin WITH A ROW.
 *
 * grantee_claims.decided_by references users(id), so a session carrying an
 * invented id fails the foreign key the moment a decision is recorded -- which
 * is the schema insisting a decision has a decider who exists.
 */
const admin = adminSession();
await db.prepare(
  `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
   VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
).bind(admin.userId, `claims-admin-${crypto.randomUUID().slice(0, 8)}@example.org`,
       nowIso(), nowIso()).run();

// ---------------------------------------------------------------------------

describe('filing a claim', () => {
  it('records it, and grants nothing', async () => {
    const body = claimBody();
    const res = await post('/api/public/grantee-claim', body);
    expect(res.status).toBe(200);

    const row = await db.prepare(
      `SELECT status, granted_user_id, granted_award_id, contact_email FROM grantee_claims
        WHERE contact_email = ?`,
    ).bind(body.email).first<Record<string, unknown>>();
    expect(row?.status).toBe('pending');
    expect(row?.granted_user_id).toBeNull();
    expect(row?.granted_award_id).toBeNull();

    // No account came into existence.
    const user = await db.prepare(`SELECT id FROM users WHERE email = ?`)
      .bind(body.email).first();
    expect(user, 'filing a claim must not create an account').toBeNull();
  });

  it('answers a claim that matches an award EXACTLY as one that does not', async () => {
    /*
     * THE ORACLE TEST. If these two differ in any way a caller can see, the
     * endpoint becomes a way to ask "have you funded this EIN" and get an
     * answer, for every EIN on every Form 990.
     */
    const funded = await fundedOrg();
    const hit = await post('/api/public/grantee-claim', claimBody({ ein: funded.ein }));
    const miss = await post('/api/public/grantee-claim', claimBody({ ein: '001234567' }));

    expect(hit.status).toBe(miss.status);
    expect(await hit.text()).toBe(await miss.text());
  });

  it('still matches internally, because a reviewer needs the hint', async () => {
    const funded = await fundedOrg();
    const body = claimBody({ ein: funded.ein });
    await post('/api/public/grantee-claim', body);
    const row = await db.prepare(
      `SELECT matched_organization_id, matched_award_id FROM grantee_claims WHERE contact_email = ?`,
    ).bind(body.email).first<Record<string, unknown>>();
    expect(row?.matched_organization_id).toBe(funded.orgId);
    expect(row?.matched_award_id).toBe(funded.awardId);
  });

  it('refuses when Turnstile is not configured and not explicitly opted out', async () => {
    // The posture the public form ships with: no secret, no opt-out, no entry.
    const res = await post('/api/public/grantee-claim', claimBody(), {
      ...env(), TURNSTILE_OPTIONAL: undefined,
    } as Env);
    expect(res.status).toBe(403);
  });

  it('answers a second claim from one address the same way, and writes one row', async () => {
    // The unique index refuses it. "You already have a claim" would tell
    // anyone who guesses an address that somebody there claimed a grant.
    const body = claimBody();
    const first = await post('/api/public/grantee-claim', body);
    const second = await post('/api/public/grantee-claim', body);
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM grantee_claims WHERE contact_email = ?`,
    ).bind(body.email).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('records the acknowledgement email', async () => {
    const body = claimBody();
    await post('/api/public/grantee-claim', body);
    const id = (await db.prepare(`SELECT id FROM grantee_claims WHERE contact_email = ?`)
      .bind(body.email).first<{ id: string }>())!.id;
    const mail = await db.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key = ?`,
    ).bind(`grantee_claim_received:${id}`).first<{ n: number }>();
    expect(mail!.n).toBe(1);
  });

  it('keeps what they typed even when the EIN is unusable', () => {
    // A half-typed EIN is dropped rather than refused: the claim is still
    // useful to a human, and the column's CHECK means it cannot be stored as
    // if it were real.
    const parsed = readClaim({ ...claimBody(), ein: '76-12' });
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) expect(parsed.ein).toBeNull();
  });

  it('refuses a claim with no organization or no usable address', () => {
    expect('error' in readClaim({ ...claimBody(), organizationName: '  ' })).toBe(true);
    expect('error' in readClaim({ ...claimBody(), email: 'not-an-address' })).toBe(true);
  });
});

describe('approving one', () => {
  async function pending(over: Record<string, unknown> = {}) {
    const body = claimBody(over);
    await post('/api/public/grantee-claim', body);
    // The PENDING one. An address may hold several claims over time once the
    // earlier ones are decided, and an unordered lookup by email handed back
    // the first -- so a test about a second claim was asserting against the
    // first, already-approved one.
    const row = await db.prepare(
      `SELECT id FROM grantee_claims WHERE contact_email = ? AND status = 'pending'`,
    ).bind(body.email).first<{ id: string }>();
    return { claimId: row!.id, email: body.email };
  }

  it('connects the person to the award a REVIEWER chose', async () => {
    const funded = await fundedOrg();
    const c = await pending();
    const out = await approveClaim(env(), ctxFor(admin), admin, c.claimId,
      { awardId: funded.awardId }, { transport: null });

    expect(out.awardId).toBe(funded.awardId);
    const user = await db.prepare(
      `SELECT id, role, organization_id, is_active FROM users WHERE email = ?`,
    ).bind(c.email).first<Record<string, unknown>>();
    expect(user?.role).toBe('grantee');
    expect(user?.organization_id).toBe(funded.orgId);
    expect(user?.is_active).toBe(1);

    const claim = await db.prepare(
      `SELECT status, granted_user_id, granted_award_id, decided_by FROM grantee_claims WHERE id = ?`,
    ).bind(c.claimId).first<Record<string, unknown>>();
    expect(claim?.status).toBe('approved');
    expect(claim?.granted_award_id).toBe(funded.awardId);
    expect(claim?.decided_by).toBe(admin.userId);
  });

  it('ignores what the system itself guessed and uses the award it was given', async () => {
    // matched_award_id comes from an EIN printed on a public tax filing.
    // Acting on it would make the guess the decision.
    const guessed = await fundedOrg();
    const chosen = await fundedOrg();
    const c = await pending({ ein: guessed.ein });
    const out = await approveClaim(env(), ctxFor(admin), admin, c.claimId,
      { awardId: chosen.awardId }, { transport: null });
    expect(out.awardId).toBe(chosen.awardId);
    expect(out.awardId).not.toBe(guessed.awardId);
  });

  it('opens the report periods, so there is something to file', async () => {
    const funded = await fundedOrg();
    const c = await pending();
    const out = await approveClaim(env(), ctxFor(admin), admin, c.claimId,
      { awardId: funded.awardId }, { transport: null });
    expect(out.periodsCreated).toBeGreaterThan(0);
    const periods = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_periods WHERE award_id = ?`,
    ).bind(funded.awardId).first<{ n: number }>();
    expect(periods!.n).toBeGreaterThan(0);
  });

  it('still grants access when the award has no term to generate from', async () => {
    // An imported spreadsheet award may have no dates. That is a gap for
    // staff to fill, not a reason to refuse somebody the access they were
    // just connected to.
    const funded = await fundedOrg({ termed: false });
    const c = await pending();
    const out = await approveClaim(env(), ctxFor(admin), admin, c.claimId,
      { awardId: funded.awardId }, { transport: null });
    expect(out.periodsCreated).toBe(0);
    expect(out.userId).toBeTruthy();
    const claim = await db.prepare(`SELECT status FROM grantee_claims WHERE id = ?`)
      .bind(c.claimId).first<{ status: string }>();
    expect(claim!.status).toBe('approved');
  });

  it('refuses an address already attached to a different organization', async () => {
    const a = await fundedOrg();
    const b = await fundedOrg();
    const c = await pending();
    await approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: a.awardId }, { transport: null });

    const second = await pending({ email: c.email });
    const err = await appErrorFrom(
      approveClaim(env(), ctxFor(admin), admin, second.claimId, { awardId: b.awardId }, { transport: null }),
    );
    expect(err.publicMessage).toMatch(/different organization/i);
  });

  it('refuses a claim that has already been decided', async () => {
    const funded = await fundedOrg();
    const c = await pending();
    await approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: funded.awardId }, { transport: null });
    const err = await appErrorFrom(
      approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: funded.awardId }, { transport: null }),
    );
    expect(err.publicMessage).toMatch(/already been decided/i);
  });

  it('refuses a cancelled award, and an award that does not exist', async () => {
    const funded = await fundedOrg();
    await db.prepare(`UPDATE awards SET status='cancelled' WHERE id=?`).bind(funded.awardId).run();
    const c = await pending();
    // publicMessage, not Error.message: the internal message also contains
    // "cancelled", so a toThrow here passed while asserting nothing about
    // what an admin was actually told.
    const cancelled = await appErrorFrom(
      approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: funded.awardId }, { transport: null }),
    );
    expect(cancelled.publicMessage).toMatch(/cancelled/i);
    const missing = await appErrorFrom(
      approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: newId() }, { transport: null }),
    );
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('writes an audit row naming what it granted', async () => {
    const funded = await fundedOrg();
    const c = await pending();
    await approveClaim(env(), ctxFor(admin), admin, c.claimId, { awardId: funded.awardId }, { transport: null });
    const row = await db.prepare(
      `SELECT after_json FROM audit_log WHERE action='grantee_claim.approved' AND entity_id=?`,
    ).bind(c.claimId).first<{ after_json: string }>();
    const after = JSON.parse(row!.after_json) as Record<string, unknown>;
    expect(after.granted_award_id).toBe(funded.awardId);
    expect(after.organization_id).toBe(funded.orgId);
  });

  it('lets the approved grantee see their award, and not another one', async () => {
    /*
     * THE POINT OF THE WHOLE FEATURE, and the thing that would matter most if
     * it were wrong. The portal is scoped by organization_id from the session,
     * so this also proves the claim attached the user to the RIGHT one.
     */
    const mine = await fundedOrg();
    const theirs = await fundedOrg();
    const c = await pending();
    const out = await approveClaim(env(), ctxFor(admin), admin, c.claimId,
      { awardId: mine.awardId }, { transport: null });

    const { sessionToken } = await createSession(env(), out.userId);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/grantee/home`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, 'cf-connecting-ip': '203.0.113.9' },
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { awards: { id: string }[] };
    const ids = body.awards.map((a) => a.id);
    expect(ids).toContain(mine.awardId);
    expect(ids).not.toContain(theirs.awardId);
  });
});

describe('declining one', () => {
  async function pending() {
    const body = claimBody();
    await post('/api/public/grantee-claim', body);
    const row = await db.prepare(`SELECT id FROM grantee_claims WHERE contact_email = ?`)
      .bind(body.email).first<{ id: string }>();
    return row!.id;
  }

  it('requires a reason, because the next reader needs one', async () => {
    const id = await pending();
    // The PUBLIC message, not Error.message -- which on an AppError is the
    // internal one, so a plain toThrow here passes against any failure at all.
    const err = await appErrorFrom(rejectClaim(db, ctxFor(admin), admin, id, '   '));
    expect(err.publicMessage).toMatch(/say why/i);
  });

  it('records the decision and sends nothing', async () => {
    /*
     * NO EMAIL, deliberately. "We have no record of funding you" should come
     * from a person who can say it kindly and answer the next question, not
     * from an automated message at two in the morning. CLAUDE.md holds this
     * line for decline letters and the same reasoning applies.
     */
    const id = await pending();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM email_messages`).first<{ n: number }>();
    await rejectClaim(db, ctxFor(admin), admin, id, 'No award in our records for this EIN.');
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM email_messages`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    const row = await db.prepare(
      `SELECT status, decision_note, decided_by FROM grantee_claims WHERE id = ?`,
    ).bind(id).first<Record<string, unknown>>();
    expect(row?.status).toBe('rejected');
    expect(row?.decision_note).toContain('No award');
    expect(row?.decided_by).toBe(admin.userId);
  });

  it('refuses to decide one twice', async () => {
    const id = await pending();
    await rejectClaim(db, ctxFor(admin), admin, id, 'Duplicate of an earlier claim.');
    const err = await appErrorFrom(rejectClaim(db, ctxFor(admin), admin, id, 'Again.'));
    expect(err.publicMessage).toMatch(/already been decided/i);
  });
});

describe('the queue', () => {
  it('puts what needs deciding first', async () => {
    const funded = await fundedOrg();
    const oldBody = claimBody();
    await post('/api/public/grantee-claim', oldBody);
    const decided = (await db.prepare(`SELECT id FROM grantee_claims WHERE contact_email=?`)
      .bind(oldBody.email).first<{ id: string }>())!.id;
    await approveClaim(env(), ctxFor(admin), admin, decided, { awardId: funded.awardId }, { transport: null });

    const freshBody = claimBody();
    await post('/api/public/grantee-claim', freshBody);

    const rows = await listClaims(db);
    const pendingIdx = rows.findIndex((r) => r.contactEmail === freshBody.email);
    const decidedIdx = rows.findIndex((r) => r.id === decided);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx, 'a decided claim must not sit above one still waiting')
      .toBeLessThan(decidedIdx);
  });

  it('is admin only', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/grantee-claims`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }),
      env(),
      {} as ExecutionContext,
    );
    expect([401, 404]).toContain(res.status);
  });
});
