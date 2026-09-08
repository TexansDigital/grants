import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { auditStatement, diffFields } from '../src/lib/audit';
import { parseCurrencyToCents, assertCents, MAX_CENTS } from '../src/lib/money';
import { newId } from '../src/lib/ids';

/**
 * Gaps the mutation audit found: the suite proved audit rows EXIST and barely
 * tested what is in them, and money's runtime guards were carried entirely by
 * the database's CHECK constraints.
 */

describe('money: the runtime guards, not just the database CHECKs', () => {
  it('a NUMBER of dollars becomes CENTS', () => {
    // Every existing money test passes strings, and passes numbers only to
    // prove rejection. Nothing asserted the conversion itself, so deleting the
    // `* 100` stored $25,000 as $250.00 with the whole suite green.
    expect(parseCurrencyToCents(25000)).toBe(2_500_000);
    expect(parseCurrencyToCents(0)).toBe(0);
    expect(parseCurrencyToCents(1)).toBe(100);
  });

  it('pins the ceiling exactly, from both sides', () => {
    // "caps absurd amounts" used a value so large it stayed rejected even with
    // the ceiling raised tenfold, so the bound itself was never pinned.
    expect(() => assertCents(MAX_CENTS)).not.toThrow();
    expect(() => assertCents(MAX_CENTS + 1)).toThrow();
    expect(MAX_CENTS).toBe(10_000_000_000); // $100,000,000.00
    expect(() => parseCurrencyToCents('100000000')).not.toThrow();
    expect(() => parseCurrencyToCents('100000000.01')).toThrow();
  });
});

describe('audit CONTENT, not just audit existence', () => {
  async function writeAudit(after: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entityId = newId();
    await db.batch([
      auditStatement(db, ctxFor(adminSession()), {
        action: 'program.updated',
        entityType: 'program',
        entityId,
        before: { name: 'before' },
        after,
      }),
    ]);
    return (
      (await db
        .prepare(`SELECT before_json, after_json, changed_fields_json, actor_kind FROM audit_log WHERE entity_id = ?`)
        .bind(entityId)
        .first<Record<string, unknown>>()) ?? {}
    );
  }

  it('strips submission_ip at ANY depth, which is what the name has always claimed', async () => {
    // The existing test is titled "at any depth" and its payload is flat. The
    // function's own comment says a NESTED submission_ip is the regression it
    // was written for -- so the regression could recur with the suite green.
    const row = await writeAudit({
      name: 'after',
      meta: { client: { submission_ip: '203.0.113.10', deep: { token_hash: 'abc123' } } },
    });
    const json = String(row.after_json);
    expect(json).not.toContain('203.0.113.10');
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('submission_ip');
    expect(json).not.toContain('token_hash');
    // The rest of the object survives -- stripping is surgical, not scorched.
    expect(json).toContain('after');
  });

  it('redacts secret-shaped values inside a snapshot', async () => {
    const row = await writeAudit({ name: 'after', note: 'authorization: Bearer sk_live_abcdefghijklmnop' });
    expect(String(row.after_json)).not.toContain('sk_live_abcdefghijklmnop');
  });

  it('never names a stripped key in changed_fields', () => {
    // changed_fields_json is a column people query. A submission_ip appearing
    // there as a NAME defeats the point of the exclusion list.
    const changed = diffFields(
      { name: 'a', submission_ip: '1.2.3.4', token_hash: 'x' },
      { name: 'b', submission_ip: '5.6.7.8', token_hash: 'y' },
    );
    expect(changed).toContain('name');
    expect(changed).not.toContain('submission_ip');
    expect(changed).not.toContain('token_hash');
  });

  it('records an ANONYMOUS actor as anonymous', async () => {
    // Hardcoding actor_kind to 'user' would record a public-form action as a
    // signed-in one.
    const entityId = newId();
    const anon = { ...ctxFor(null) };
    await db.batch([
      auditStatement(db, anon, {
        action: 'application.created',
        entityType: 'application',
        entityId,
        after: { status: 'draft' },
      }),
    ]);
    const row = await db
      .prepare(`SELECT actor_kind, actor_user_id FROM audit_log WHERE entity_id = ?`)
      .bind(entityId)
      .first<{ actor_kind: string; actor_user_id: string | null }>();
    expect(row?.actor_kind).toBe('anonymous');
    expect(row?.actor_user_id).toBeNull();
  });

  it('refuses a contentless audit row', () => {
    expect(() =>
      auditStatement(db, ctxFor(adminSession()), {
        action: 'program.updated',
        entityType: 'program',
        entityId: newId(),
      }),
    ).toThrow(/before or an after/);
  });
});
