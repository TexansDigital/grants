import { describe, it, expect } from 'vitest';
import { db } from './helpers';
import { isLoginStale } from '../src/lib/auth';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * Sign-ins are recorded. Before this, recordLogin existed and was called from
 * nowhere, so there was no record anywhere of who had accessed a system holding
 * other organizations' EINs and audited financial statements.
 */
describe('the sign-in staleness gate', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');

  it('records a first-ever sign-in', () => {
    expect(isLoginStale(null, now)).toBe(true);
    expect(isLoginStale(undefined, now)).toBe(true);
  });

  it('does NOT record again within the hour', () => {
    expect(isLoginStale('2026-09-08T11:30:00.000Z', now)).toBe(false);
    expect(isLoginStale('2026-09-08T11:00:00.001Z', now)).toBe(false);
  });

  it('records again once an hour has passed', () => {
    expect(isLoginStale('2026-09-08T11:00:00.000Z', now)).toBe(true);
    expect(isLoginStale('2026-09-07T12:00:00.000Z', now)).toBe(true);
  });

  it('treats a malformed timestamp as stale, not as fresh', () => {
    // Recording an extra sign-in is harmless. Skipping one because a date could
    // not be parsed loses the evidence.
    expect(isLoginStale('not a date', now)).toBe(true);
    expect(isLoginStale('', now)).toBe(true);
  });

  it('a future timestamp does not trigger a write', () => {
    expect(isLoginStale('2027-01-01T00:00:00.000Z', now)).toBe(false);
  });
});

describe('recordLogin writes an append-only audit row', () => {
  it('stamps last_login_at and an auth.logged_in row', async () => {
    const { recordLogin } = await import('../src/lib/auth');
    const id = newId();
    const email = `admin-${id}@example.org`;
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
         VALUES (?,?,'admin',NULL,?,1,?,?)`,
      )
      .bind(id, email, email, now, now)
      .run();

    const session = { userId: id, email, role: 'admin' as const, organizationId: null };
    const ctx = {
      requestId: newId(), session: null, ip: '203.0.113.10',
      userAgent: 'vitest', route: '/api/session', method: 'GET',
    };
    await recordLogin({ DB: db } as never, ctx, session);

    const user = await db
      .prepare(`SELECT last_login_at FROM users WHERE id = ?`)
      .bind(id)
      .first<{ last_login_at: string | null }>();
    expect(user?.last_login_at).toBeTruthy();

    const audit = await db
      .prepare(`SELECT action, actor_user_id, ip FROM audit_log WHERE entity_id = ? AND action='auth.logged_in'`)
      .bind(id)
      .first<Record<string, unknown>>();
    expect(audit?.action).toBe('auth.logged_in');
    expect(audit?.actor_user_id).toBe(id);
    // The IP is on the audit row, so "who was in the system on Tuesday" is
    // answerable. It is NOT copied into the before/after snapshot -- audit.ts
    // strips submission_ip and friends recursively.
    expect(audit?.ip).toBe('203.0.113.10');
  });
});
