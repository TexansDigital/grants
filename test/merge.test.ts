import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { findDuplicateCandidates, planMerge, applyMerge } from '../src/lib/merge';
import { resolveMergeTarget } from '../src/lib/identity';
import { checkCompliance } from '../src/lib/compliance';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

let seq = 0;
const admin = adminSession();
const ctx = () => ctxFor(admin);
const day = (s: string) => `${s}T00:00:00.000Z`;

async function org(over: { name?: string; ein?: string | null } = {}) {
  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(id, over.name ?? `Bayou Reach Collective ${++seq}`,
         over.ein === undefined ? String(770000000 + ++seq) : over.ein, now, now).run();
  return id;
}

async function contact(organizationId: string, email: string) {
  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO contacts (id, organization_id, first_name, last_name, email, created_at, updated_at)
     VALUES (?,?,'Alex','Moreno',?,?,?)`,
  ).bind(id, organizationId, email, now, now).run();
  return id;
}

async function user(organizationId: string, email: string) {
  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
  ).bind(id, email, organizationId, now, now).run();
  return id;
}

async function award(organizationId: string, programId: string) {
  const id = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
       status, source_system, source_reference, created_at, updated_at)
     VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?)`,
  ).bind(id, organizationId, programId, 2_500_000, now, `MG-${id.slice(0, 8)}`, now, now).run();
  return id;
}

async function application(organizationId: string, p: Awaited<ReturnType<typeof seedProgram>>) {
  const id = newId();
  const now = nowIso();
  const cycleId = Object.values(p.cycleIds)[0]!;
  const stageId = Object.values(p.stageIds)[0]!;
  const formId = Object.values(p.formDefinitionIds)[0]!;
  await db.prepare(
    `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
       status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'draft', ?,?)`,
  ).bind(id, cycleId, stageId, organizationId, formId, now, now).run();
  return id;
}

const program = () =>
  seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `mg-${++seq}` });

// ---------------------------------------------------------------------------
describe('who may merge', () => {
  it('lets a reviewer look but never merge', async () => {
    const a = await org({ ein: '771111111' });
    const b = await org({ ein: '771111111' });
    const reviewer = reviewerSession();
    await expect(findDuplicateCandidates(db, reviewer)).resolves.toBeTruthy();
    await expect(planMerge(db, reviewer, a, b)).resolves.toBeTruthy();
    await expect(applyMerge(db, ctx(), reviewer, a, b))
      .rejects.toMatchObject({ httpStatus: 403 });
  });

  it('refuses an applicant outright, look included', async () => {
    const a = await org();
    const b = await org();
    const outsider = applicantSession(a);
    await expect(findDuplicateCandidates(db, outsider))
      .rejects.toMatchObject({ httpStatus: 403 });
    await expect(planMerge(db, outsider, a, b)).rejects.toMatchObject({ httpStatus: 403 });
  });
});

// ---------------------------------------------------------------------------
describe('finding them', () => {
  it('groups two records under one EIN', async () => {
    const ein = '772222222';
    const a = await org({ ein, name: 'Harbor Trust' });
    const b = await org({ ein, name: 'Harbor Trust Houston' });
    const groups = await findDuplicateCandidates(db, admin);
    const found = groups.find((g) => g.reason === 'same_ein' && g.key === ein);
    expect(found).toBeTruthy();
    expect(found!.organizations.map((o) => o.id).sort()).toEqual([a, b].sort());
  });

  it('groups two records under one name, punctuation and suffixes aside', async () => {
    // Crude on purpose: it exists to put a pair in front of a human, not to
    // decide anything.
    const a = await org({ name: 'The Bayou Reach Collective, Inc.', ein: '773333333' });
    const b = await org({ name: 'Bayou Reach Collective', ein: '774444444' });
    const groups = await findDuplicateCandidates(db, admin);
    const found = groups.find(
      (g) => g.reason === 'same_name' && g.organizations.some((o) => o.id === a),
    );
    expect(found).toBeTruthy();
    expect(found!.organizations.map((o) => o.id).sort()).toEqual([a, b].sort());
  });

  it('does not report the same pair twice', async () => {
    // Matched on EIN and on name. Saying it twice makes the queue look twice
    // as bad as it is.
    const ein = '775555555';
    const a = await org({ ein, name: 'Twice Over' });
    await org({ ein, name: 'Twice Over' });
    const groups = await findDuplicateCandidates(db, admin);
    const mentioning = groups.filter((g) => g.organizations.some((o) => o.id === a));
    expect(mentioning).toHaveLength(1);
  });

  it('ignores an organization that has already been merged', async () => {
    const ein = '776666666';
    const a = await org({ ein });
    const b = await org({ ein });
    await applyMerge(db, ctx(), admin, a, b);
    const groups = await findDuplicateCandidates(db, admin);
    expect(groups.find((g) => g.key === ein)).toBeUndefined();
  });

  it('never groups organizations that simply have no EIN', async () => {
    // Two records with nothing in the EIN field are not the same nonprofit
    // twice. Blank is the normal state on a record entered before the IRS
    // number was to hand.
    await org({ ein: null, name: 'No Ein One' });
    await org({ ein: null, name: 'No Ein Two' });
    await org({ ein: null, name: 'No Ein Three' });

    const byEin = (await findDuplicateCandidates(db, admin))
      .filter((g) => g.reason === 'same_ein');
    expect(byEin.some((g) => g.key === null || g.key === '')).toBe(false);
    expect(byEin.some((g) => g.organizations.some((o) => o.ein === null))).toBe(false);
  });

  it('refuses to hold an EIN that is neither blank nor nine digits', async () => {
    // Worth pinning here because it is what makes half the duplicate query's
    // guards unreachable: the schema CHECK means an EIN is NULL or exactly
    // nine digits, so there is no empty-string case to defend against.
    await expect(org({ ein: '' })).rejects.toThrow(/CHECK constraint/);
    await expect(org({ ein: '12-3456789' })).rejects.toThrow(/CHECK constraint/);
  });

  it('counts what each record actually holds, so an admin can pick the live one', async () => {
    const p = await program();
    const ein = '777777777';
    const busy = await org({ ein });
    const empty = await org({ ein });
    await application(busy, p);
    await award(busy, p.programId);
    await contact(busy, `busy-${seq}@example.org`);

    const groups = await findDuplicateCandidates(db, admin);
    const g = groups.find((x) => x.key === ein)!;
    const b = g.organizations.find((o) => o.id === busy)!;
    const e = g.organizations.find((o) => o.id === empty)!;
    expect(b).toMatchObject({ applications: 1, awards: 1, contacts: 1 });
    expect(e).toMatchObject({ applications: 0, awards: 0, contacts: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('planning one', () => {
  it('counts everything that would move', async () => {
    const p = await program();
    const survivor = await org();
    const dup = await org();
    await application(dup, p);
    await award(dup, p.programId);
    await contact(dup, `dup-${seq}@example.org`);
    await user(dup, `dupuser-${seq}@example.org`);

    const plan = await planMerge(db, admin, survivor, dup);
    expect(plan.ok).toBe(true);
    expect(plan.moves).toMatchObject({
      applications: 1, awards: 1, contacts: 1, users: 1, contactsRetired: 0,
    });
  });

  it('spots a contact both records already hold', async () => {
    const survivor = await org();
    const dup = await org();
    const shared = `shared-${++seq}@example.org`;
    await contact(survivor, shared);
    await contact(dup, shared);
    await contact(dup, `other-${seq}@example.org`);

    const plan = await planMerge(db, admin, survivor, dup);
    // Not a conflict: it is the same person, and their duplicate is retired.
    expect(plan.ok).toBe(true);
    expect(plan.moves).toMatchObject({ contacts: 1, contactsRetired: 1 });
  });

  it('refuses to merge a record into itself', async () => {
    const a = await org();
    const plan = await planMerge(db, admin, a, a);
    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]).toContain('into itself');
  });

  it('refuses a record that has already been merged away', async () => {
    const a = await org();
    const b = await org();
    const c = await org();
    await applyMerge(db, ctx(), admin, a, b);
    const plan = await planMerge(db, admin, c, b);
    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]).toContain('already been merged');
  });

  it('404s an organization that does not exist', async () => {
    const a = await org();
    await expect(planMerge(db, admin, a, 'nope')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('stops a merge that would put the survivor over a program application cap', async () => {
    /*
     * The conflict that is not about state but about consequence, and it was
     * found by reading the trigger rather than by hitting it. The per-cycle
     * cap is enforced BEFORE INSERT, so re-pointing rows with an UPDATE walks
     * straight past it -- merging would leave the survivor over the limit with
     * nothing to say so.
     */
    const p = await program();
    const survivor = await org();
    const dup = await org();
    await application(survivor, p);
    await application(dup, p);

    const plan = await planMerge(db, admin, survivor, dup);
    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]).toContain('Withdraw one of them first');
    await expect(applyMerge(db, ctx(), admin, survivor, dup))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it('allows it when the program sets no cap', async () => {
    const p = await seedProgram(db, ctx(), {
      ...INSPIRE_CHANGE, slug: `mg-nocap-${++seq}`, maxApplicationsPerCycle: null,
    });
    const survivor = await org();
    const dup = await org();
    await application(survivor, p);
    await application(dup, p);
    expect((await planMerge(db, admin, survivor, dup)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('doing it', () => {
  it('moves every kind of record to the survivor', async () => {
    const p = await program();
    const survivor = await org();
    const dup = await org();
    const appId = await application(dup, p);
    const awardId = await award(dup, p.programId);
    const contactId = await contact(dup, `moved-${++seq}@example.org`);
    const userId = await user(dup, `moveduser-${seq}@example.org`);

    const out = await applyMerge(db, ctx(), admin, survivor, dup);
    expect(out).toMatchObject({ applications: 1, awards: 1, contacts: 1, users: 1 });

    for (const [table, id] of [
      ['applications', appId], ['awards', awardId], ['contacts', contactId], ['users', userId],
    ] as const) {
      const row = await db.prepare(
        `SELECT organization_id AS o FROM ${table} WHERE id=?`,
      ).bind(id).first<{ o: string }>();
      expect(row!.o, table).toBe(survivor);
    }
  });

  it('leaves the duplicate as a signpost rather than deleting it', async () => {
    // An id held in an old email, a bookmark or a spreadsheet still has to
    // resolve to something.
    const survivor = await org();
    const dup = await org();
    await applyMerge(db, ctx(), admin, survivor, dup);

    const row = await db.prepare(
      `SELECT status, merged_into_id, deleted_at FROM organizations WHERE id=?`,
    ).bind(dup).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'merged', merged_into_id: survivor, deleted_at: null });
    expect(await resolveMergeTarget(db, dup)).toBe(survivor);
  });

  it('retires a duplicate contact instead of colliding on the unique index', async () => {
    const survivor = await org();
    const dup = await org();
    const shared = `collide-${++seq}@example.org`;
    await contact(survivor, shared);
    const doomed = await contact(dup, shared);

    const out = await applyMerge(db, ctx(), admin, survivor, dup);
    expect(out.contactsRetired).toBe(1);

    const row = await db.prepare(`SELECT organization_id, deleted_at FROM contacts WHERE id=?`)
      .bind(doomed).first<Record<string, unknown>>();
    expect(row!.deleted_at).not.toBeNull();
    // One live contact on the survivor for that address, not two.
    const live = await db.prepare(
      `SELECT COUNT(*) AS n FROM contacts WHERE organization_id=? AND email=? AND deleted_at IS NULL`,
    ).bind(survivor, shared).first<{ n: number }>();
    expect(live!.n).toBe(1);
  });

  it('moves a report draft with the award it belongs to', async () => {
    // report_drafts.organization_id is denormalized from the award, and a
    // trigger refuses a draft whose organization does not match. Moving the
    // draft before the award takes the whole merge down.
    const p = await program();
    const survivor = await org();
    const dup = await org();
    const awardId = await award(dup, p.programId);
    const now = nowIso();
    const periodId = newId();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, created_at, updated_at)
       VALUES (?,?,'Final report','final',?,?,?)`,
    ).bind(periodId, awardId, day('2026-03-31'), now, now).run();
    const formId = Object.values(p.formDefinitionIds)[0]!;
    const draftId = newId();
    await db.prepare(
      `INSERT INTO report_drafts (id, report_period_id, organization_id, form_definition_id,
         answers_json, updated_at, created_at)
       VALUES (?,?,?,?,'{}',?,?)`,
    ).bind(draftId, periodId, dup, formId, now, now).run();

    const out = await applyMerge(db, ctx(), admin, survivor, dup);
    expect(out.reportDrafts).toBe(1);
    const row = await db.prepare(`SELECT organization_id AS o FROM report_drafts WHERE id=?`)
      .bind(draftId).first<{ o: string }>();
    expect(row!.o).toBe(survivor);
  });

  it('audits the merge with both sides and what moved', async () => {
    const p = await program();
    const survivor = await org({ name: 'Survivor Trust' });
    const dup = await org({ name: 'Duplicate Trust' });
    await award(dup, p.programId);
    await applyMerge(db, ctx(), admin, survivor, dup);

    const row = await db.prepare(
      `SELECT before_json, after_json FROM audit_log
        WHERE action='organization.merged' AND entity_id=?`,
    ).bind(dup).first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(row!.before_json)).toMatchObject({ legal_name: 'Duplicate Trust' });
    const after = JSON.parse(row!.after_json) as {
      merged_into_id: string; survivor_legal_name: string; moved: { awards: number };
    };
    expect(after).toMatchObject({
      merged_into_id: survivor, survivor_legal_name: 'Survivor Trust',
    });
    expect(after.moved.awards).toBe(1);
  });

  it('merges once when two admins click at the same time', async () => {
    const survivor = await org();
    const dup = await org();
    const results = await Promise.allSettled([
      applyMerge(db, ctx(), admin, survivor, dup),
      applyMerge(db, ctx(), admin, survivor, dup),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const audits = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='organization.merged' AND entity_id=?`,
    ).bind(dup).first<{ n: number }>();
    expect(audits!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('what merging actually fixes', () => {
  it('makes the compliance gate see history the duplicate was hiding', async () => {
    /*
     * The concrete hole this tool closes. A returning grantee who applies from
     * a new address lands in a fresh record with no award and nothing overdue,
     * so a program set to `block` lets them straight past. Merging is what
     * reunites them with what they owe.
     */
    const p = await seedProgram(db, ctx(), {
      ...INSPIRE_CHANGE, slug: `mg-cmp-${++seq}`, compliancePolicy: 'block',
    });
    const ein = '778888888';
    const known = await org({ ein });
    const duplicate = await org({ ein });

    const awardId = await award(known, p.programId);
    const now = nowIso();
    await db.prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, status,
         created_at, updated_at)
       VALUES (?,?,'Final report','final',?,'open',?,?)`,
    ).bind(newId(), awardId, day('2020-01-01'), now, now).run();

    // Before: the duplicate is clean, because it holds nothing.
    expect((await checkCompliance(db, p.programId, duplicate)).decision).toBe('allow');
    expect((await checkCompliance(db, p.programId, known)).decision).toBe('block');

    await applyMerge(db, ctx(), admin, known, duplicate);

    // After: the duplicate id resolves to the record that owes the report.
    expect((await checkCompliance(db, p.programId, duplicate)).decision).toBe('block');
  });
});
