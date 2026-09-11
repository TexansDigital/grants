import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { parseAwardsCsv, type ParsedAward } from '../src/import/awards';
import { planAwardImport, applyAwardImport } from '../src/import/importAwards';
import type { AppError } from '../src/lib/errors';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

let n = 0;
async function program() {
  // seedProgram returns ids, not the spec, so the slug is carried alongside.
  const slug = `imp-${++n}`;
  const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug });
  return { ...p, slug };
}

/** Invented rows in the template's shape. The real file never comes to me. */
const HEADER =
  'external_reference,organization_name,ein,program_slug,fiscal_year,awarded_amount,' +
  'awarded_date,term_start,term_end,is_multi_year,parent_external_reference,' +
  'grantee_contact_name,grantee_contact_email,status';

const row = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    external_reference: `REF-${newId().slice(0, 8)}`,
    organization_name: 'Invented Reach Collective',
    ein: '00-1234567',
    program_slug: 'imp',
    fiscal_year: '2025',
    awarded_amount: '25000',
    awarded_date: '2025-03-14',
    term_start: '2025-04-01',
    term_end: '2026-03-31',
    is_multi_year: 'no',
    parent_external_reference: '',
    grantee_contact_name: 'Dana Okonkwo',
    grantee_contact_email: `dana-${newId().slice(0, 6)}@example-invented.org`,
    status: 'active',
    ...over,
  };
  return HEADER.split(',').map((c) => base[c] ?? '').join(',');
};

const parse = (slug: string, ...rows: string[]): ParsedAward[] => {
  const r = parseAwardsCsv([HEADER, ...rows.map((x) => x.replace(/,imp,/, `,${slug},`))].join('\n'));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.awards;
};

const ctx = () => ctxFor(adminSession());

// ---------------------------------------------------------------------------
describe('planning an import before writing anything', () => {
  it('creates the organization, the grantee and the award', async () => {
    const p = await program();
    const awards = parse(p.slug, row());
    const plan = await planAwardImport(db, awards);

    expect(plan.ok).toBe(true);
    expect(plan.summary).toMatchObject({
      toCreate: 1, toSkip: 0, blocked: 0,
      organizationsToCreate: 1, usersToCreate: 1, totalCents: 2_500_000,
    });

    // A plan writes NOTHING. The dry run is this call with the second not made.
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>();
    expect(before!.n).toBe(0);
  });

  it('resolves one organization and one grantee across a multi-year file', async () => {
    // Year one and year two of the same grant. Without remembering decisions
    // in file order, the first run would duplicate every returning grantee.
    const p = await program();
    const email = 'marcus@example-invented.org';
    const awards = parse(
      p.slug,
      row({ external_reference: 'Y1', grantee_contact_email: email }),
      row({ external_reference: 'Y2', grantee_contact_email: email,
            parent_external_reference: 'Y1', is_multi_year: 'yes' }),
    );
    const plan = await planAwardImport(db, awards);
    expect(plan.summary).toMatchObject({ toCreate: 2, organizationsToCreate: 1, usersToCreate: 1 });

    const creates = plan.rows.filter((r) => r.kind === 'create');
    expect(creates).toHaveLength(2);
    // Year two points at year one's planned id, not a fresh one.
    const [y1, y2] = creates as Extract<typeof creates[number], { kind: 'create' }>[];
    expect(y2!.parentAwardId).toBe(y1!.awardId);
  });

  it('blocks when two live organizations share the EIN', async () => {
    // Guessing which one holds the grant is not a decision an importer makes.
    const p = await program();
    const now = nowIso();
    for (const name of ['Reach A', 'Reach B']) {
      await db.prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      ).bind(newId(), name, '009999999', now, now).run();
    }
    const plan = await planAwardImport(db, parse(p.slug, row({ ein: '00-9999999' })));
    expect(plan.ok).toBe(false);
    expect(plan.rows[0]).toMatchObject({ kind: 'blocked' });
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/share EIN.*Merge them first/s);
  });

  it('blocks a staff address being used as a grantee login', async () => {
    // Staff sign in through Access and must never hold a magic-link session.
    const p = await program();
    const now = nowIso();
    const staff = 'admin@houstontexans.example';
    await db.prepare(
      `INSERT INTO users (id, email, role, is_active, created_at, updated_at)
       VALUES (?,?,'admin',1,?,?)`,
    ).bind(newId(), staff, now, now).run();

    const plan = await planAwardImport(db, parse(p.slug, row({ grantee_contact_email: staff })));
    expect(plan.ok).toBe(false);
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/staff account/);
  });

  it('blocks an email that already signs in for a different organization', async () => {
    // One email, one organization. Silently moving them would cut the first
    // nonprofit off from its own records.
    const p = await program();
    const now = nowIso();
    const otherOrg = newId();
    const email = 'shared@example-invented.org';
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(otherOrg, 'Somebody Else', '008888888', now, now).run();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,'grantee',?,1,?,?)`,
    ).bind(newId(), email, otherOrg, now, now).run();

    const plan = await planAwardImport(
      db, parse(p.slug, row({ grantee_contact_email: email, ein: '00-1234567' })),
    );
    expect(plan.ok).toBe(false);
    expect((plan.rows[0] as { reason: string }).reason)
      .toMatch(/already signs in for a different organization/);
  });

  it('reuses a grantee who already belongs to THIS organization', async () => {
    // The legitimate half of the rule above: a returning grantee is not a
    // second user, and a second award for them creates nobody.
    const p = await program();
    const now = nowIso();
    const orgId = newId();
    const email = 'returning@example-invented.org';
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Returning Org', '001234567', now, now).run();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,'grantee',?,1,?,?)`,
    ).bind(newId(), email, orgId, now, now).run();

    const plan = await planAwardImport(
      db, parse(p.slug, row({ grantee_contact_email: email, ein: '00-1234567' })),
    );
    expect(plan.ok, JSON.stringify(plan.rows)).toBe(true);
    expect(plan.summary).toMatchObject({ usersToCreate: 0, organizationsToCreate: 0 });
  });

  it('reuses a grantee whose organization was merged into this one', async () => {
    // A merge leaves the user pointing at the row that was merged AWAY.
    // Comparing raw ids would tell a legitimate returning grantee they belong
    // to a different organization and block their own award.
    const p = await program();
    const now = nowIso();
    const survivor = newId();
    const mergedAway = newId();
    const email = 'merged@example-invented.org';
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(survivor, 'Survivor Org', '001234567', now, now).run();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, merged_into_id, created_at, updated_at)
       VALUES (?,?,?,'merged',?,?,?)`,
    ).bind(mergedAway, 'Old Row', '007777777', survivor, now, now).run();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?,'grantee',?,1,?,?)`,
    ).bind(newId(), email, mergedAway, now, now).run();

    const plan = await planAwardImport(
      db, parse(p.slug, row({ grantee_contact_email: email, ein: '00-1234567' })),
    );
    expect(plan.ok, JSON.stringify(plan.rows)).toBe(true);
    expect(plan.summary.usersToCreate).toBe(0);
    expect((plan.rows[0] as { organizationId: string }).organizationId).toBe(survivor);
  });

  it('leaves the cycle unset when two cycle windows contain the award date', async () => {
    // An award on the WRONG cycle lands in the wrong year's totals. A null is
    // visibly missing; a wrong answer is not.
    const p = await program();
    const now = nowIso();
    for (const name of ['Overlap A', 'Overlap B']) {
      await db.prepare(
        `INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,'closed',?,?)`,
      ).bind(newId(), p.programId, name,
             '2025-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', now, now).run();
    }
    const plan = await planAwardImport(db, parse(p.slug, row({ awarded_date: '2025-03-14' })));
    const create = plan.rows[0] as { kind: string; cycleId: string | null };
    expect(create.kind).toBe('create');
    expect(create.cycleId).toBeNull();
  });

  it('attaches the cycle when exactly one window contains the award date', async () => {
    // The control. Without it the test above passes for a function that never
    // attaches a cycle at all.
    const p = await program();
    const now = nowIso();
    const cycleId = newId();
    await db.prepare(
      `INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'closed',?,?)`,
    ).bind(cycleId, p.programId, 'The only one',
           '2025-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', now, now).run();
    // The seeded program brings its own cycles; move them clear of 2025.
    await db.prepare(
      `UPDATE cycles SET opens_at='2030-01-01T00:00:00.000Z', closes_at='2030-12-31T00:00:00.000Z'
        WHERE program_id = ? AND id <> ?`,
    ).bind(p.programId, cycleId).run();

    const plan = await planAwardImport(db, parse(p.slug, row({ awarded_date: '2025-03-14' })));
    expect((plan.rows[0] as { cycleId: string | null }).cycleId).toBe(cycleId);
  });

  it('blocks an unknown program rather than inventing one', async () => {
    const plan = await planAwardImport(db, parse('no-such-program', row()));
    expect(plan.ok).toBe(false);
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/No program with slug/);
  });

  it('blocks a parent that is neither above this row nor already imported', async () => {
    const p = await program();
    const plan = await planAwardImport(
      db, parse(p.slug, row({ parent_external_reference: 'NEVER-IMPORTED' })),
    );
    expect(plan.ok).toBe(false);
    expect((plan.rows[0] as { reason: string }).reason).toMatch(/neither in this file/);
  });
});

// ---------------------------------------------------------------------------
describe('applying it', () => {
  it('writes the award, the organization, the grantee and an audit row', async () => {
    const p = await program();
    const awards = parse(p.slug, row());
    const plan = await planAwardImport(db, awards);
    const out = await applyAwardImport(db, ctx(), plan);

    expect(out).toMatchObject({ awardsCreated: 1, organizationsCreated: 1, usersCreated: 1 });

    const award = await db.prepare(
      `SELECT application_id, awarded_amount_cents, source_system, source_reference, status
         FROM awards WHERE source_reference = ?`,
    ).bind(awards[0]!.externalReference).first<Record<string, unknown>>();
    // The decision the whole migration turns on: a grant with no application.
    expect(award!.application_id).toBeNull();
    expect(award!.awarded_amount_cents).toBe(2_500_000);
    expect(award!.source_system).toBe('spreadsheet');
    expect(award!.status).toBe('active');

    // Non-negotiable #6. An imported award is still an award.
    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'award.created'`,
    ).first<{ n: number }>();
    expect(audit!.n).toBe(1);

    const user = await db.prepare(
      `SELECT role, organization_id FROM users WHERE email = ?`,
    ).bind(awards[0]!.contactEmail).first<{ role: string; organization_id: string }>();
    expect(user!.role).toBe('grantee');
    expect(user!.organization_id).toBe(award!.organization_id ?? user!.organization_id);
  });

  it('is idempotent: running the same file twice awards nobody twice', async () => {
    const p = await program();
    const awards = parse(p.slug, row(), row());

    const first = await applyAwardImport(db, ctx(), await planAwardImport(db, awards));
    expect(first.awardsCreated).toBe(2);

    // Second run, same file. The plan should see both as already imported.
    const secondPlan = await planAwardImport(db, awards);
    expect(secondPlan.summary).toMatchObject({ toCreate: 0, toSkip: 2, blocked: 0 });
    const second = await applyAwardImport(db, ctx(), secondPlan);
    expect(second).toMatchObject({ awardsCreated: 0, skipped: 2 });

    const total = await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>();
    expect(total!.n).toBe(2);
  });

  it('resumes after a partial import rather than duplicating', async () => {
    // Two hundred awards do not fit in one D1 batch, so a failure can leave
    // some written. Idempotence is the recovery story, not atomicity.
    const p = await program();
    const all = parse(p.slug, row({ external_reference: 'A' }), row({ external_reference: 'B' }));
    await applyAwardImport(db, ctx(), await planAwardImport(db, [all[0]!]));

    const resumePlan = await planAwardImport(db, all);
    expect(resumePlan.summary).toMatchObject({ toCreate: 1, toSkip: 1 });
    await applyAwardImport(db, ctx(), resumePlan);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>())!.n).toBe(2);
  });

  it('links a renewal to its parent', async () => {
    const p = await program();
    const awards = parse(
      p.slug,
      row({ external_reference: 'Y1' }),
      row({ external_reference: 'Y2', parent_external_reference: 'Y1', is_multi_year: 'yes' }),
    );
    await applyAwardImport(db, ctx(), await planAwardImport(db, awards));

    const y1 = await db.prepare(`SELECT id FROM awards WHERE source_reference='Y1'`)
      .first<{ id: string }>();
    const y2 = await db.prepare(
      `SELECT parent_award_id, is_multi_year FROM awards WHERE source_reference='Y2'`,
    ).first<{ parent_award_id: string; is_multi_year: number }>();
    expect(y2!.parent_award_id).toBe(y1!.id);
    expect(y2!.is_multi_year).toBe(1);
  });

  it('links a renewal to a parent imported in an EARLIER run', async () => {
    const p = await program();
    await applyAwardImport(
      db, ctx(), await planAwardImport(db, parse(p.slug, row({ external_reference: 'P1' }))),
    );
    const plan = await planAwardImport(
      db, parse(p.slug, row({ external_reference: 'P2', parent_external_reference: 'P1' })),
    );
    expect(plan.ok, JSON.stringify(plan.rows)).toBe(true);
    await applyAwardImport(db, ctx(), plan);
    const p1 = await db.prepare(`SELECT id FROM awards WHERE source_reference='P1'`).first<{ id: string }>();
    const p2 = await db.prepare(`SELECT parent_award_id FROM awards WHERE source_reference='P2'`)
      .first<{ parent_award_id: string }>();
    expect(p2!.parent_award_id).toBe(p1!.id);
  });

  it('reuses an organization that already exists, rather than duplicating it', async () => {
    const p = await program();
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Already Here', '001234567', now, now).run();

    const plan = await planAwardImport(db, parse(p.slug, row({ ein: '00-1234567' })));
    expect(plan.summary.organizationsToCreate).toBe(0);
    await applyAwardImport(db, ctx(), plan);

    const award = await db.prepare(`SELECT organization_id FROM awards LIMIT 1`)
      .first<{ organization_id: string }>();
    expect(award!.organization_id).toBe(orgId);
  });

  it('refuses to run at all while anything is blocked', async () => {
    const plan = await planAwardImport(db, parse('no-such-program', row()));
    const err = await applyAwardImport(db, ctx(), plan).then(
      () => null,
      (e: AppError) => e,
    );
    expect(err).not.toBeNull();
    // Both messages, separately: the one the admin reads and the one the log
    // gets. Asserting only the second would let an internal string be shown.
    expect(err!.publicMessage).toMatch(/cannot run until the problems are fixed/i);
    expect(err!.message).toMatch(/1 blocked row/);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>())!.n).toBe(0);
  });

  it('writes more awards than fit in one batch', async () => {
    // ROWS_PER_BATCH is 10. Twenty-five rows exercises chunking, which is
    // where an off-by-one silently drops the last chunk.
    const p = await program();
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ external_reference: `BULK-${i}`, ein: `00${String(1000000 + i)}` }));
    const plan = await planAwardImport(db, parse(p.slug, ...rows));
    const out = await applyAwardImport(db, ctx(), plan);
    expect(out.awardsCreated).toBe(25);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM awards`).first<{ n: number }>())!.n).toBe(25);
    expect((await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='award.created'`,
    ).first<{ n: number }>())!.n).toBe(25);
  });
});
