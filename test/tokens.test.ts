import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { db, ctxFor } from './helpers';
import {
  generateToken, hashToken, issueLoginToken, consumeLoginToken,
  supersedeOutstandingTokens, TOKEN_TTL_MS,
} from '../src/lib/tokens';
import {
  createSession, resolveSession, signOut, isRevoked, mayHoldExternalSession, SESSION_TTL_MS,
  sessionCookie, clearedSessionCookie, readSessionCookie, SESSION_COOKIE,
} from '../src/lib/sessions';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Role } from '../src/types';

const testEnv = env as unknown as Env;
const ctx = () => ctxFor(null);

async function makeOrg(): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(id, 'Invented Futures Inc', '001112223', now, now)
    .run();
  return id;
}

async function makeUser(
  over: { role?: Role; isActive?: number; organizationId?: string | null } = {},
): Promise<string> {
  const role = over.role ?? 'applicant';
  const orgId =
    over.organizationId !== undefined
      ? over.organizationId
      : role === 'applicant' || role === 'grantee'
        ? await makeOrg()
        : null;
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(id, `u${id.slice(0, 8)}@example.org`, role, orgId, over.isActive ?? 1, now, now)
    .run();
  return id;
}

// ---------------------------------------------------------------------------
describe('token generation', () => {
  it('is unguessable and URL-safe', () => {
    const t = generateToken();
    // 32 bytes in unpadded base64url.
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encodeURIComponent(t)).toBe(t);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(seen.size).toBe(500);
  });

  it('draws its full length from the CSPRNG, not just a prefix', async () => {
    // The length regex above passes with 4 of 32 bytes random and the rest
    // zeroes -- the token stays 43 characters. Entropy was asserted nowhere.
    // Decode and check every byte position actually varies across samples.
    const decode = (t: string): Uint8Array => {
      const b64 = t.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    };
    const samples = Array.from({ length: 300 }, () => decode(generateToken()));
    expect(samples[0]!.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      const distinct = new Set(samples.map((s) => s[i]));
      // 300 draws from 256 values: seeing fewer than 50 distinct means this
      // byte is not random. A constant byte yields exactly 1.
      expect(distinct.size, `byte ${i} is not random`).toBeGreaterThan(50);
    }
  });

  it('hashes the WHOLE token, not a prefix of it', async () => {
    // The pinned digest below uses 'abc', which is shorter than any plausible
    // truncation, so hashToken(token.slice(0, 8)) passed every assertion --
    // including the round-trip check, which runs both sides through it.
    const a = `${'x'.repeat(40)}AAAA`;
    const b = `${'x'.repeat(40)}BBBB`;
    expect(await hashToken(a)).not.toBe(await hashToken(b));
    // Independent pin on a long input.
    expect(await hashToken('a'.repeat(43))).toBe(
      await hashToken('a'.repeat(43)),
    );
    expect(await hashToken('a'.repeat(43))).not.toBe(await hashToken('a'.repeat(42)));
  });

  it('hashes to 64 hex characters, deterministically', async () => {
    const h = await hashToken('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Pinned against a known SHA-256 so a change of algorithm cannot pass.
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashToken('abd')).not.toBe(h);
  });
});

// ---------------------------------------------------------------------------
describe('issuing', () => {
  it('stores only the hash, never the token', async () => {
    const userId = await makeUser();
    const issued = await issueLoginToken(db, ctx(), { userId, email: 'A@Example.org' });

    const row = await db
      .prepare(`SELECT * FROM login_tokens WHERE id = ?`)
      .bind(issued.tokenId)
      .first<Record<string, unknown>>();

    // Scan the WHOLE row: a token copied into a column added later would slip
    // past an assertion that only checks the ones we know about today.
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row!.token_hash).toBe(await hashToken(issued.token));
    expect(row!.sent_to_email).toBe('a@example.org'); // normalized
    expect(row!.consumed_at).toBeNull();
    expect(row!.requested_ip).toBe('203.0.113.10');
  });

  it('expires in fifteen minutes', async () => {
    const userId = await makeUser();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const issued = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org', now });
    expect(issued.expiresAt).toBe('2026-03-01T12:15:00.000Z');
    expect(TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
describe('consuming', () => {
  it('works once and only once', async () => {
    const userId = await makeUser();
    const { token } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });

    const first = await consumeLoginToken(db, ctx(), token);
    expect(first).toMatchObject({ ok: true, userId });

    const second = await consumeLoginToken(db, ctx(), token);
    expect(second).toEqual({ ok: false, reason: 'already_used' });
  });

  it('two simultaneous clicks produce exactly one sign-in', async () => {
    // The property the whole D1-instead-of-KV argument rests on.
    const userId = await makeUser();
    const { token } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });

    const results = await Promise.all([
      consumeLoginToken(db, ctx(), token),
      consumeLoginToken(db, ctx(), token),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const userId = await makeUser();
    const issuedAt = new Date('2026-03-01T12:00:00.000Z');
    const { token } = await issueLoginToken(db, ctx(), {
      userId, email: 'a@example.org', now: issuedAt,
    });
    const later = new Date(issuedAt.getTime() + TOKEN_TTL_MS + 1000);
    expect(await consumeLoginToken(db, ctx(), token, { now: later })).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('is exact at the expiry boundary', async () => {
    const userId = await makeUser();
    const issuedAt = new Date('2026-03-01T12:00:00.000Z');
    const { token } = await issueLoginToken(db, ctx(), {
      userId, email: 'a@example.org', now: issuedAt,
    });
    // BOTH halves. Only the first was asserted, so > vs >= was invisible.
    const justBefore = new Date(issuedAt.getTime() + TOKEN_TTL_MS - 1);
    expect((await consumeLoginToken(db, ctx(), token, { now: justBefore })).ok).toBe(true);

    const second = await issueLoginToken(db, ctx(), {
      userId: await makeUser(), email: 'b@example.org', now: issuedAt,
    });
    const exactly = new Date(issuedAt.getTime() + TOKEN_TTL_MS);
    expect(await consumeLoginToken(db, ctx(), second.token, { now: exactly })).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('refuses a token whose account was deactivated after it was sent', async () => {
    // Checked in the WHERE clause, not by the caller: resolveSession would
    // catch it on the next request, but a route trusting ok:true would already
    // have set a cookie and said "you're signed in".
    const userId = await makeUser();
    const { token } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await db.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).bind(userId).run();
    expect((await consumeLoginToken(db, ctx(), token)).ok).toBe(false);
  });

  it('refuses a token whose account was soft-deleted', async () => {
    const userId = await makeUser();
    const { token } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await db.prepare(`UPDATE users SET deleted_at = ? WHERE id = ?`).bind(nowIso(), userId).run();
    expect((await consumeLoginToken(db, ctx(), token)).ok).toBe(false);
  });

  it('refuses a token that was never issued', async () => {
    expect(await consumeLoginToken(db, ctx(), generateToken())).toEqual({
      ok: false, reason: 'unknown',
    });
  });

  it('records where the link was used', async () => {
    const userId = await makeUser();
    const { token, tokenId } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await consumeLoginToken(db, ctx(), token);
    const row = await db
      .prepare(`SELECT consumed_ip, consumed_user_agent, consumed_at FROM login_tokens WHERE id = ?`)
      .bind(tokenId)
      .first<{ consumed_ip: string; consumed_user_agent: string; consumed_at: string }>();
    expect(row!.consumed_ip).toBe('203.0.113.10');
    expect(row!.consumed_user_agent).toBe('vitest');
    expect(row!.consumed_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('superseding', () => {
  it('a newer link kills the older one, with no ordering for a caller to get wrong', async () => {
    // issueLoginToken supersedes internally. The old shape -- issue, then call
    // supersede -- voided the link that was already in the email, silently,
    // and nothing in the signature stopped you.
    const userId = await makeUser();
    const first = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    const second = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });

    expect(await consumeLoginToken(db, ctx(), first.token)).toEqual({
      ok: false, reason: 'superseded',
    });
    expect((await consumeLoginToken(db, ctx(), second.token)).ok).toBe(true);
  });

  it('leaves an already-expired token reported as expired, not superseded', async () => {
    // Superseding an expired token would change what the person is told, from
    // "your link expired, request another" to "we sent you a newer one".
    const userId = await makeUser();
    const t0 = new Date('2026-03-01T12:00:00.000Z');
    const old = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org', now: t0 });
    const later = new Date(t0.getTime() + TOKEN_TTL_MS + 60_000);
    await issueLoginToken(db, ctx(), { userId, email: 'a@example.org', now: later });
    expect(await consumeLoginToken(db, ctx(), old.token, { now: later })).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('does not mark an unused link as if somebody signed in with it', async () => {
    // consumed_at is evidence of a sign-in. Borrowing it to mean "replaced"
    // would put sign-ins that never happened into the record.
    const userId = await makeUser();
    const { tokenId } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await supersedeOutstandingTokens(db, userId);
    const row = await db
      .prepare(`SELECT consumed_at, superseded_at FROM login_tokens WHERE id = ?`)
      .bind(tokenId)
      .first<{ consumed_at: string | null; superseded_at: string | null }>();
    expect(row!.consumed_at).toBeNull();
    expect(row!.superseded_at).toBeTruthy();
  });

  it('leaves the tokens of another user alone', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    const theirToken = await issueLoginToken(db, ctx(), { userId: theirs, email: 'b@example.org' });
    await issueLoginToken(db, ctx(), { userId: mine, email: 'a@example.org' });

    expect(await supersedeOutstandingTokens(db, mine)).toBe(1);
    expect((await consumeLoginToken(db, ctx(), theirToken.token)).ok).toBe(true);
  });

  it('does not resurrect or disturb an already-consumed token', async () => {
    const userId = await makeUser();
    const { token } = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await consumeLoginToken(db, ctx(), token);
    expect(await supersedeOutstandingTokens(db, userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the database refuses to weaken a token', () => {
  async function aToken() {
    const userId = await makeUser();
    const issued = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    return { ...issued, userId };
  }

  it('a row cannot be deleted', async () => {
    const t = await aToken();
    await expect(
      db.prepare(`DELETE FROM login_tokens WHERE id = ?`).bind(t.tokenId).run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('INSERT OR REPLACE cannot free a consumed token by colliding on its hash', async () => {
    // The exact hole migration 0007 left open on email_messages, guarded here
    // on both unique keys from the start.
    const t = await aToken();
    await consumeLoginToken(db, ctx(), t.token);
    const hash = await hashToken(t.token);
    await expect(
      db.prepare(
        `INSERT OR REPLACE INTO login_tokens
           (id, token_hash, user_id, sent_to_email, purpose, issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(newId(), hash, t.userId, 'a@example.org', '2026-01-01T00:00:00.000Z',
             '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run(),
    ).rejects.toThrow(/already exists/);

    // And it is still spent.
    expect(await consumeLoginToken(db, ctx(), t.token)).toEqual({
      ok: false, reason: 'already_used',
    });
  });

  it('a consumed token cannot be un-consumed', async () => {
    const t = await aToken();
    await consumeLoginToken(db, ctx(), t.token);
    await expect(
      db.prepare(`UPDATE login_tokens SET consumed_at = NULL WHERE id = ?`).bind(t.tokenId).run(),
    ).rejects.toThrow(/settled token cannot be modified/);
  });

  it('expiry cannot be extended and the owner cannot be changed', async () => {
    const t = await aToken();
    await expect(
      db.prepare(`UPDATE login_tokens SET expires_at = '2030-01-01T00:00:00.000Z' WHERE id = ?`)
        .bind(t.tokenId).run(),
    ).rejects.toThrow(/frozen/);
    await expect(
      db.prepare(`UPDATE login_tokens SET user_id = ? WHERE id = ?`)
        .bind(await makeUser(), t.tokenId).run(),
    ).rejects.toThrow(/frozen/);
  });

  it('a superseded token cannot be un-superseded or rewritten', async () => {
    // Only the consumed half of login_tokens_single_use was covered; deleting
    // the superseded half was invisible.
    const userId = await makeUser();
    const first = await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await issueLoginToken(db, ctx(), { userId, email: 'a@example.org' });
    await expect(
      db.prepare(`UPDATE login_tokens SET superseded_at = NULL WHERE id = ?`)
        .bind(first.tokenId).run(),
    ).rejects.toThrow(/settled token cannot be modified/);
  });

  it('INSERT OR REPLACE cannot collide on the primary key either', async () => {
    // The both-keys guard was only tested on token_hash; the id half was
    // deletable with the whole suite green.
    const t = await aToken();
    await expect(
      db.prepare(
        `INSERT OR REPLACE INTO login_tokens
           (id, token_hash, user_id, sent_to_email, purpose, issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(t.tokenId, 'f'.repeat(64), t.userId, 'a@example.org',
             '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z').run(),
    ).rejects.toThrow(/already exists/);
  });

  it('freezes the hash, the recipient and the issue time as well', async () => {
    // Three of the five frozen columns were unasserted.
    const t = await aToken();
    for (const [col, val] of [
      ['token_hash', 'a'.repeat(64)],
      ['sent_to_email', 'attacker@example.org'],
      ['issued_at', '2020-01-01T00:00:00.000Z'],
    ] as const) {
      await expect(
        db.prepare(`UPDATE login_tokens SET ${col} = ? WHERE id = ?`).bind(val, t.tokenId).run(),
      ).rejects.toThrow(/frozen/);
    }
  });

  it('freezes the request forensics, which cannot be reconstructed later', async () => {
    const t = await aToken();
    await expect(
      db.prepare(`UPDATE login_tokens SET requested_ip = '9.9.9.9' WHERE id = ?`)
        .bind(t.tokenId).run(),
    ).rejects.toThrow(/forensics are frozen/);
    await expect(
      db.prepare(`UPDATE login_tokens SET requested_user_agent = 'wiped' WHERE id = ?`)
        .bind(t.tokenId).run(),
    ).rejects.toThrow(/forensics are frozen/);
  });

  it('refuses a redemption forged to a date after the token expired', async () => {
    // This killed a live link AND wrote permanent false evidence of a sign-in,
    // on a table with no delete path.
    const t = await aToken();
    await expect(
      db.prepare(`UPDATE login_tokens SET consumed_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`)
        .bind(t.tokenId).run(),
    ).rejects.toThrow(/cannot be after expires_at/);
  });

  it('refuses a non-ISO expiry, which the string comparison would misread', async () => {
    // '2026-03-01T14:00:00+02:00' sorts after '2026-03-01T12:00:00.500Z', so
    // an offset-form row stayed valid two hours past its real expiry.
    await expect(
      db.prepare(
        `INSERT INTO login_tokens (id, token_hash, user_id, sent_to_email, purpose,
           issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(newId(), 'b'.repeat(64), await makeUser(), 'a@example.org',
             '2026-03-01T12:00:00.000Z', '2026-03-01T14:00:00+02:00',
             '2026-03-01T12:00:00.000Z').run(),
    ).rejects.toThrow(/ISO-8601 UTC/);
  });

  it('refuses a hash that is not a SHA-256, and a duplicate hash', async () => {
    const t = await aToken();
    // t.userId is real, so a rejection here is the hash constraint, not the FK.
    const insert = (hash: string) =>
      db.prepare(
        `INSERT INTO login_tokens (id, token_hash, user_id, sent_to_email, purpose,
           issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(newId(), hash, t.userId, 'a@example.org', '2026-03-01T12:00:00.000Z',
             '2026-03-01T12:15:00.000Z', '2026-03-01T12:00:00.000Z').run();
    await expect(insert('a'.repeat(64))).resolves.toBeTruthy(); // control
    await expect(insert('tooshort')).rejects.toThrow();
    await expect(insert(await hashToken(t.token))).rejects.toThrow(/already exists/);
  });

  it('refuses an unnormalized recipient and an unknown purpose', async () => {
    // A REAL user id. Binding a nonexistent one made the FK throw first, so
    // these assertions passed with the CHECK under test deleted.
    const userId = await makeUser();
    let n = 0;
    const insert = (email: string, purpose: string) =>
      db.prepare(
        `INSERT INTO login_tokens (id, token_hash, user_id, sent_to_email, purpose,
           issued_at, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(newId(), String(++n).padStart(64, 'e'), userId, email, purpose,
             '2026-03-01T12:00:00.000Z', '2026-03-01T12:15:00.000Z',
             '2026-03-01T12:00:00.000Z').run();

    // The control: identical insert with valid values must SUCCEED, so a
    // rejection above cannot be blamed on the surrounding statement.
    await expect(insert('a@example.org', 'sign_in')).resolves.toBeTruthy();
    await expect(insert('MixedCase@example.org', 'sign_in')).rejects.toThrow();
    await expect(insert('b@example.org', 'password_reset')).rejects.toThrow();
  });

  it('refuses an expiry at or before issue', async () => {
    await expect(
      db.prepare(
        `INSERT INTO login_tokens (id, token_hash, user_id, sent_to_email, purpose,
           issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(newId(), 'c'.repeat(64), await makeUser(), 'a@example.org',
             '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z',
             '2026-03-01T12:00:00.000Z').run(),
    ).rejects.toThrow();
  });

  it('refuses a token for a user that does not exist', async () => {
    await expect(
      db.prepare(
        `INSERT INTO login_tokens (id, token_hash, user_id, sent_to_email, purpose,
           issued_at, expires_at, created_at)
         VALUES (?,?,?,?,'sign_in',?,?,?)`,
      ).bind(newId(), 'd'.repeat(64), 'no-such-user', 'a@example.org',
             '2026-03-01T12:00:00.000Z', '2026-03-01T12:15:00.000Z',
             '2026-03-01T12:00:00.000Z').run(),
    ).rejects.toThrow();
  });

  it('a token cannot be both used and replaced', async () => {
    const t = await aToken();
    await expect(
      db.prepare(
        `UPDATE login_tokens SET consumed_at = ?, superseded_at = ? WHERE id = ?`,
      ).bind(nowIso(), nowIso(), t.tokenId).run(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('sessions', () => {
  it('resolves to the user, with current role and organization', async () => {
    const orgId = await makeOrg();
    const userId = await makeUser({ organizationId: orgId });
    const { sessionToken } = await createSession(testEnv, userId);

    const session = await resolveSession(testEnv, sessionToken);
    expect(session).toMatchObject({ userId, role: 'applicant', organizationId: orgId });
  });

  it('lives seven days and refuses an expired record', async () => {
    const userId = await makeUser();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const { sessionToken, expiresAt } = await createSession(testEnv, userId, { now });

    // Pin the constant absolutely. Comparing the computed expiry to the same
    // constant that computed it is a tautology -- it passed with the TTL set
    // to 30 days and to 365 days.
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBe('2026-03-08T12:00:00.000Z');

    // Both sides of the boundary: exactly at expiry is dead, not just after.
    const exactly = new Date(now.getTime() + SESSION_TTL_MS);
    expect(await resolveSession(testEnv, sessionToken, { now: exactly })).toBeNull();
    const justBefore = new Date(now.getTime() + SESSION_TTL_MS - 1);
    expect(await resolveSession(testEnv, sessionToken, { now: justBefore })).not.toBeNull();
  });

  it('draws the session token from the CSPRNG at full length', async () => {
    // There was no session analogue of the token entropy test at all.
    const decode = (t: string): Uint8Array => {
      const b64 = t.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    };
    const userId = await makeUser();
    const samples: Uint8Array[] = [];
    for (let i = 0; i < 120; i++) {
      samples.push(decode((await createSession(testEnv, userId)).sessionToken));
    }
    expect(samples[0]!.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(new Set(samples.map((x) => x[i])).size, `byte ${i}`).toBeGreaterThan(30);
    }
  });

  it('refuses an unknown or empty token', async () => {
    expect(await resolveSession(testEnv, '')).toBeNull();
    expect(await resolveSession(testEnv, generateToken())).toBeNull();
  });

  it('stores the session under a hash, not under the token', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    // The raw token is not a usable KV key, so a dump of the namespace is not
    // a list of live credentials.
    expect(await testEnv.SESSIONS.get(`session:${sessionToken}`)).toBeNull();
    expect(await testEnv.SESSIONS.get(`session:${await hashToken(sessionToken)}`)).toBeTruthy();
  });

  it('does not store the role or organization, so both stay current', async () => {
    // Caching them in the record would let a deactivated or re-scoped user
    // keep their old access until the session happened to expire.
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    const raw = await testEnv.SESSIONS.get(`session:${await hashToken(sessionToken)}`);
    // Structural, not two substring probes. The old assertions were
    // not.toContain('applicant') and not.toContain('organization'), which a
    // record caching `role: 'grantee'` or a key spelled `orgId` walked past.
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual(['expiresAt', 'issuedAt', 'userId']);
  });

  it('never invents an organization when the row has none', async () => {
    // An APPLICANT with a null organization_id -- the users CHECK forbids the
    // row, so it takes a stub Env to present it. Using an admin instead makes
    // the role guard fire first, and a fallback like
    // `organization_id ?? 'some-org'` would scope somebody to an organization
    // that is not theirs with the whole suite green.
    const stub = {
      SESSIONS: {
        get: async () =>
          JSON.stringify({
            userId: 'u1',
            issuedAt: '2026-03-01T12:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
      },
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              id: 'u1',
              email: 'a@example.org',
              role: 'applicant' as Role,
              organization_id: null,
              is_active: 1,
              sessions_valid_from: null,
            }),
          }),
        }),
      },
    } as unknown as Env;
    expect(await resolveSession(stub, 'any-token')).toBeNull();
  });

  it('drops a session the moment the user is deactivated', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    expect(await resolveSession(testEnv, sessionToken)).not.toBeNull();

    await db.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).bind(userId).run();
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });

  it('drops a session for a soft-deleted user', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    await db.prepare(`UPDATE users SET deleted_at = ? WHERE id = ?`).bind(nowIso(), userId).run();
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });

  it('refuses a staff role arriving down the applicant path', async () => {
    const adminId = await makeUser({ role: 'admin', organizationId: null });
    const { sessionToken } = await createSession(testEnv, adminId);
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });

  it('rejects a staff role even when the row somehow carries an organization', async () => {
    // My previous commit claimed this "cannot be made to" fail a test, because
    // the users CHECK forbids a staff row with an organization_id. That was
    // wrong: resolveSession touches env only through SESSIONS.get and
    // DB.prepare, so a stub Env can present exactly the row the CHECK forbids.
    // This is the case the guard exists for -- the day that CHECK is relaxed.
    const stub = {
      SESSIONS: {
        get: async () =>
          JSON.stringify({
            userId: 'staff-1',
            issuedAt: '2026-03-01T12:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
      },
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              id: 'staff-1',
              email: 'admin@example.org',
              role: 'admin' as Role,
              organization_id: 'org-1', // the shape the CHECK forbids
              is_active: 1,
              sessions_valid_from: null,
            }),
          }),
        }),
      },
    } as unknown as Env;

    expect(await resolveSession(stub, 'any-token')).toBeNull();
  });

  it('names exactly which roles may hold a magic-link session', () => {
    // Tested directly rather than through resolveSession. Every staff role
    // also has a null organization_id, so the org guard rejects them too and
    // deleting the role check entirely leaves the test above passing -- a
    // defence whose absence cannot be observed is a defence nothing protects.
    expect(mayHoldExternalSession('applicant')).toBe(true);
    expect(mayHoldExternalSession('grantee')).toBe(true);
    expect(mayHoldExternalSession('admin')).toBe(false);
    expect(mayHoldExternalSession('reviewer')).toBe(false);
    expect(mayHoldExternalSession('executive')).toBe(false);
  });

  it('refuses a corrupt record rather than treating it as valid', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    const key = `session:${await hashToken(sessionToken)}`;

    await testEnv.SESSIONS.put(key, 'not json');
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();

    await testEnv.SESSIONS.put(key, JSON.stringify({ userId, issuedAt: 'x', expiresAt: 'y' }));
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();

    await testEnv.SESSIONS.put(key, JSON.stringify({ expiresAt: '2099-01-01T00:00:00.000Z' }));
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('sign out is immediate, despite KV', () => {
  it('ends this session', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    await signOut(testEnv, sessionToken, userId);
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });

  it('ends sessions on other devices too, without waiting for KV', async () => {
    // The reason sessions can stay in KV at all. Signing out on one device
    // moves the cutoff, which every other session is measured against on its
    // next request -- no dependence on a delete propagating.
    const userId = await makeUser();
    const phone = await createSession(testEnv, userId);
    const laptop = await createSession(testEnv, userId);

    await signOut(testEnv, phone.sessionToken, userId);

    // The laptop's KV record is deliberately still present.
    expect(await testEnv.SESSIONS.get(`session:${await hashToken(laptop.sessionToken)}`)).toBeTruthy();
    expect(await resolveSession(testEnv, laptop.sessionToken)).toBeNull();
  });

  it('removes the KV record, not only the cutoff', async () => {
    // The KV delete is called housekeeping in the comment, and was untested --
    // sign-out passed purely on sessions_valid_from, so an abandoned record
    // could have lingered for its full seven days.
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    const key = `session:${await hashToken(sessionToken)}`;
    expect(await testEnv.SESSIONS.get(key)).toBeTruthy();
    await signOut(testEnv, sessionToken, userId);
    expect(await testEnv.SESSIONS.get(key)).toBeNull();
  });

  it('refuses to move the revocation cutoff backwards', async () => {
    // Sign-out is only irreversible if the cutoff never decreases. Nulling it
    // resurrected every session revoked in the previous seven days.
    const userId = await makeUser();
    await signOut(testEnv, null, userId);
    await expect(
      db.prepare(`UPDATE users SET sessions_valid_from = NULL WHERE id = ?`).bind(userId).run(),
    ).rejects.toThrow(/cannot move backwards/);
    await expect(
      db.prepare(`UPDATE users SET sessions_valid_from = '2000-01-01T00:00:00.000Z' WHERE id = ?`)
        .bind(userId).run(),
    ).rejects.toThrow(/cannot move backwards/);
  });

  it('a revoked session stays revoked after an attempt to clear the cutoff', async () => {
    const userId = await makeUser();
    const { sessionToken } = await createSession(testEnv, userId);
    await signOut(testEnv, null, userId);
    await db.prepare(`UPDATE users SET sessions_valid_from = NULL WHERE id = ?`)
      .bind(userId).run().catch(() => undefined);
    expect(await resolveSession(testEnv, sessionToken)).toBeNull();
  });

  it('lets a fresh sign-in work again afterwards', async () => {
    const userId = await makeUser();
    const old = await createSession(testEnv, userId);
    await signOut(testEnv, old.sessionToken, userId);

    const fresh = await createSession(testEnv, userId, { now: new Date(Date.now() + 1000) });
    expect(await resolveSession(testEnv, fresh.sessionToken)).not.toBeNull();
  });

  it('treats an unreadable cutoff as revoking everything', () => {
    expect(isRevoked('2026-03-01T12:00:00.000Z', null)).toBe(false);
    expect(isRevoked('2026-03-01T12:00:00.000Z', 'not-a-date')).toBe(true);
    expect(isRevoked('not-a-date', '2026-03-01T12:00:00.000Z')).toBe(true);
    expect(isRevoked('2026-03-01T11:59:59.999Z', '2026-03-01T12:00:00.000Z')).toBe(true);
    // Inclusive: Workers freeze Date.now() between I/O, so a redemption and a
    // sign-out on the same edge genuinely share a millisecond. A strict
    // comparison let that session outlive the sign-out meant to kill it.
    expect(isRevoked('2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')).toBe(true);
    expect(isRevoked('2026-03-01T12:00:00.001Z', '2026-03-01T12:00:00.000Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the session cookie', () => {
  it('carries the attributes the __Host- prefix requires', () => {
    const c = sessionCookie('abc', 3600);
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    // Exact: 'Path=/app' contains 'Path=/', and the __Host- prefix requires
    // exactly Path=/ or the browser silently rejects the cookie.
    expect(c.split('; ')).toContain('Path=/');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    // Lax, not Strict: a magic link arrives from an email client, and Strict
    // would drop the cookie on that first cross-site navigation.
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toMatch(/Domain=/);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('clears with an immediate expiry', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });

  it('reads its own cookie out of a header with others present', () => {
    const req = new Request('https://x/', {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=tok-value; another=2` },
    });
    expect(readSessionCookie(req)).toBe('tok-value');
  });

  it('returns null when absent or empty', () => {
    expect(readSessionCookie(new Request('https://x/'))).toBeNull();
    expect(
      readSessionCookie(new Request('https://x/', { headers: { cookie: 'other=1' } })),
    ).toBeNull();
    expect(
      readSessionCookie(new Request('https://x/', { headers: { cookie: `${SESSION_COOKIE}=` } })),
    ).toBeNull();
  });

  it('is not confused by a cookie whose name merely ends the same way', () => {
    const req = new Request('https://x/', {
      headers: { cookie: `evil_${SESSION_COOKIE}=attacker; ${SESSION_COOKIE}=real` },
    });
    expect(readSessionCookie(req)).toBe('real');
  });
});
