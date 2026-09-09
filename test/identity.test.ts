import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import {
  findOrganizationByEin, resolveMergeTarget, resolveApplicantIdentity,
} from '../src/lib/identity';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Role } from '../src/types';

const ctx = () => ctxFor(null);

async function org(
  over: { ein?: string | null; name?: string; mergedInto?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, merged_into_id,
         created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      over.name ?? 'Invented Futures Inc',
      over.ein === undefined ? '001112223' : over.ein,
      over.mergedInto ? 'merged' : 'active',
      over.mergedInto ?? null,
      now, now,
      over.deleted ? now : null,
    )
    .run();
  return id;
}

async function user(email: string, role: Role, organizationId: string | null): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)`,
    )
    .bind(id, email, role, organizationId, now, now)
    .run();
  return id;
}

let n = 0;
/** A distinct valid EIN per test, so tests cannot resolve each other's rows. */
const ein = () => String(100000000 + ++n);

const identity = (over: Partial<Parameters<typeof resolveApplicantIdentity>[2]> = {}) => ({
  ein: ein(),
  legalName: 'Bayou Reach Collective',
  email: `a${++n}@example.org`,
  firstName: 'Alex',
  lastName: 'Moreno',
  ...over,
});

// ---------------------------------------------------------------------------
describe('matching an organization by EIN', () => {
  it('matches regardless of how the EIN was typed', async () => {
    // The dash/no-dash case is the single most likely way one nonprofit
    // becomes two rows. Normalization is what prevents it.
    const e = ein();
    const id = await org({ ein: e });
    for (const typed of [e, `${e.slice(0, 2)}-${e.slice(2)}`, `${e.slice(0, 2)} ${e.slice(2)}`]) {
      expect(await findOrganizationByEin(db, typed)).toMatchObject({
        kind: 'matched', organizationId: id,
      });
    }
  });

  it('finds nothing for an EIN that is not nine digits', async () => {
    expect(await findOrganizationByEin(db, 'not-an-ein')).toEqual({ kind: 'none' });
    expect(await findOrganizationByEin(db, '12345')).toEqual({ kind: 'none' });
  });

  it('reports ambiguity rather than picking one of several duplicates', async () => {
    // organizations.ein has NO unique index on purpose -- duplicates are an
    // expected state. Picking one at random would file an application against
    // an arbitrary half of a split nonprofit.
    const e = ein();
    await org({ ein: e, name: 'Bayou Reach Collective' });
    await org({ ein: e, name: 'Bayou Reach Collective Inc' });
    const m = await findOrganizationByEin(db, e);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.candidates).toHaveLength(2);
  });

  it('ignores soft-deleted organizations', async () => {
    const e = ein();
    await org({ ein: e, deleted: true });
    expect(await findOrganizationByEin(db, e)).toEqual({ kind: 'none' });
  });

  it('lands on the survivor when the organization was merged away', async () => {
    // Otherwise a reapplying organization splits again the moment it returns,
    // which is the exact thing merging fixed.
    const survivor = await org({ ein: ein(), name: 'Survivor' });
    const e = ein();
    await org({ ein: e, name: 'Old Row', mergedInto: survivor });
    expect(await findOrganizationByEin(db, e)).toMatchObject({
      kind: 'matched', organizationId: survivor, legalName: 'Survivor',
    });
  });

  it('follows a chain of merges to the end', async () => {
    const c = await org({ ein: ein(), name: 'C' });
    const b = await org({ ein: ein(), name: 'B', mergedInto: c });
    const a = await org({ ein: ein(), name: 'A', mergedInto: b });
    expect(await resolveMergeTarget(db, a)).toBe(c);
  });

  it('cannot be given a merge cycle, because the database refuses one', async () => {
    // resolveMergeTarget carries a cycle guard, and it turns out that guard is
    // unreachable: 0002 already refuses a merge into a merged organization, so
    // the second edge of a cycle cannot be written. Asserting the schema
    // property is both stronger and true; the code guard stays as defence in
    // depth for the day that trigger changes, and is honestly untestable.
    const a = await org({ ein: ein(), name: 'A' });
    const b = await org({ ein: ein(), name: 'B', mergedInto: a });
    await expect(
      db.prepare(`UPDATE organizations SET status='merged', merged_into_id=? WHERE id=?`)
        .bind(b, a).run(),
    ).rejects.toThrow(/merged into a live, unmerged organization/);

    // And a self-merge is refused too.
    await expect(
      db.prepare(`UPDATE organizations SET status='merged', merged_into_id=? WHERE id=?`)
        .bind(a, a).run(),
    ).rejects.toThrow();
  });

  it('stops at a depth cap rather than following a merge chain forever', async () => {
    let tail = await org({ ein: ein(), name: 'end' });
    const end = tail;
    for (let i = 0; i < 12; i++) tail = await org({ ein: ein(), name: `n${i}`, mergedInto: tail });
    const landed = await resolveMergeTarget(db, tail);
    // It terminates. It may not have reached the end of a 12-deep chain, which
    // is the deliberate trade: a bounded walk beats an unbounded one, and a
    // chain that deep means the merge tool has a bug worth looking at.
    expect(typeof landed).toBe('string');
    expect(landed).not.toBe(tail);
    void end;
  });
});

// ---------------------------------------------------------------------------
describe('creating an applicant identity', () => {
  it('creates the organization, contact and user together', async () => {
    const input = identity();
    const out = await resolveApplicantIdentity(db, ctx(), input);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;

    expect(out.createdOrganization).toBe(true);
    expect(out.createdUser).toBe(true);

    const u = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(out.userId)
      .first<Record<string, unknown>>();
    expect(u!.role).toBe('applicant');
    expect(u!.organization_id).toBe(out.organizationId);
    expect(u!.email).toBe(input.email.toLowerCase());

    const c = await db.prepare(`SELECT * FROM contacts WHERE id=?`).bind(out.contactId)
      .first<Record<string, unknown>>();
    expect(c!.organization_id).toBe(out.organizationId);
    expect(c!.is_primary).toBe(1);

    const o = await db.prepare(`SELECT * FROM organizations WHERE id=?`).bind(out.organizationId)
      .first<Record<string, unknown>>();
    // Normalized on the way in, so next year's dashed version matches this row.
    expect(o!.ein).toBe(input.ein.replace(/\D/g, ''));
    // An IRS check is a separate step, and a mismatch there is a flag for a
    // human rather than a rejection.
    expect(o!.ein_verified_at).toBeNull();
  });

  it('writes an audit row for every row it creates', async () => {
    const out = await resolveApplicantIdentity(db, ctx(), identity());
    if (out.kind !== 'ready') throw new Error('expected ready');
    for (const [action, id] of [
      ['organization.created', out.organizationId],
      ['contact.created', out.contactId],
      ['user.created', out.userId],
    ] as const) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action=? AND entity_id=?`)
        .bind(action, id).first<{ n: number }>();
      expect(row!.n, action).toBe(1);
    }
  });

  it('reuses the organization when a second person applies for it', async () => {
    const e = ein();
    const first = await resolveApplicantIdentity(db, ctx(), identity({ ein: e }));
    const second = await resolveApplicantIdentity(db, ctx(), identity({ ein: e }));
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected ready');

    expect(second.organizationId).toBe(first.organizationId);
    expect(second.createdOrganization).toBe(false);
    expect(second.contactId).not.toBe(first.contactId);
    // The second contact does not displace the first as primary.
    const c = await db.prepare(`SELECT is_primary FROM contacts WHERE id=?`)
      .bind(second.contactId).first<{ is_primary: number }>();
    expect(c!.is_primary).toBe(0);
  });

  it('reapplies onto the surviving organization after a merge', async () => {
    // End to end, not just through findOrganizationByEin: an organization
    // merged last year must not split again the moment it returns.
    const survivorEin = ein();
    const first = await resolveApplicantIdentity(db, ctx(), identity({ ein: survivorEin }));
    if (first.kind !== 'ready') throw new Error('expected ready');

    const oldEin = ein();
    const oldId = await org({ ein: oldEin, name: 'Old Row' });
    await db
      .prepare(`UPDATE organizations SET status='merged', merged_into_id=? WHERE id=?`)
      .bind(first.organizationId, oldId)
      .run();

    const again = await resolveApplicantIdentity(db, ctx(), identity({ ein: oldEin }));
    expect(again).toMatchObject({
      kind: 'ready', organizationId: first.organizationId, createdOrganization: false,
    });
  });

  it('is idempotent for the same person applying twice', async () => {
    const input = identity();
    const a = await resolveApplicantIdentity(db, ctx(), input);
    const b = await resolveApplicantIdentity(db, ctx(), input);
    if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('expected ready');
    expect(b).toMatchObject({
      userId: a.userId, organizationId: a.organizationId, contactId: a.contactId,
      createdOrganization: false, createdUser: false,
    });

    const users = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email=?`)
      .bind(input.email.toLowerCase()).first<{ n: number }>();
    expect(users!.n).toBe(1);
  });

  it('normalizes the email so case cannot create a second account', async () => {
    const input = identity({ email: 'Director@Example.ORG' });
    const a = await resolveApplicantIdentity(db, ctx(), input);
    const b = await resolveApplicantIdentity(db, ctx(), { ...input, email: 'director@example.org' });
    if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('expected ready');
    expect(b.userId).toBe(a.userId);
  });
});

// ---------------------------------------------------------------------------
describe('what it refuses to guess', () => {
  it('refuses when several organizations share the EIN', async () => {
    const e = ein();
    await org({ ein: e, name: 'One' });
    await org({ ein: e, name: 'Two' });
    const out = await resolveApplicantIdentity(db, ctx(), identity({ ein: e }));
    expect(out.kind).toBe('ambiguous_organization');
    if (out.kind === 'ambiguous_organization') expect(out.candidates).toHaveLength(2);
  });

  it('refuses an email that already signs in for a different organization', async () => {
    // Silently reusing the user would file this application under the OTHER
    // nonprofit; silently moving them would cut the first off from its drafts.
    const other = await org({ ein: ein(), name: 'Other Nonprofit' });
    const email = `shared${++n}@example.org`;
    await user(email, 'applicant', other);

    const out = await resolveApplicantIdentity(db, ctx(), identity({ email }));
    expect(out).toEqual({
      kind: 'email_belongs_to_other_organization', existingOrganizationId: other,
    });
  });

  it('creates nothing at all when it refuses', async () => {
    const other = await org({ ein: ein(), name: 'Other Nonprofit' });
    const email = `shared${++n}@example.org`;
    await user(email, 'applicant', other);
    const e = ein();

    const before = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`).first<{ n: number }>();
    await resolveApplicantIdentity(db, ctx(), identity({ email, ein: e }));
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM organizations`).first<{ n: number }>();

    // The refusal happens after the organization would have been created, so
    // this is the assertion that proves nothing was written on the way out.
    expect(after!.n).toBe(before!.n);
    expect(await findOrganizationByEin(db, e)).toEqual({ kind: 'none' });
  });

  it('refuses a staff email, which signs in through Access', async () => {
    const email = `admin${++n}@example.org`;
    await user(email, 'admin', null);
    expect(await resolveApplicantIdentity(db, ctx(), identity({ email }))).toEqual({
      kind: 'email_belongs_to_staff',
    });
  });

  it('refuses an EIN that is not nine digits', async () => {
    expect(await resolveApplicantIdentity(db, ctx(), identity({ ein: '123' }))).toEqual({
      kind: 'invalid_ein',
    });
  });

  it('lets a grantee from the same organization apply again', async () => {
    // A past grantee reapplying is the normal case, and decision 19 says a
    // declined applicant keeps access too.
    const e = ein();
    const first = await resolveApplicantIdentity(db, ctx(), identity({ ein: e }));
    if (first.kind !== 'ready') throw new Error('expected ready');
    await db.prepare(`UPDATE users SET role='grantee' WHERE id=?`).bind(first.userId).run();

    const again = await resolveApplicantIdentity(db, ctx(), identity({
      ein: e, email: (await db.prepare(`SELECT email FROM users WHERE id=?`)
        .bind(first.userId).first<{ email: string }>())!.email,
    }));
    expect(again).toMatchObject({ kind: 'ready', userId: first.userId });
  });
});
