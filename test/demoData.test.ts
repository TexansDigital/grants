import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildDemoPlan, makeRng, buildOrganizations, pickStatus } from '../src/seed/demoData';
import { loadDemoData, __resetDemoAdminCache } from '../src/seed/loadDemoData';
import { searchApplications } from '../src/lib/search';
import { listApplicationsForStaff, organizationHistoryForStaff } from '../src/lib/scope';

const ctx = () => ctxFor(adminSession());

/** Extra cycles on the same program, so repeat applicants are possible. */
async function extraCycles(programId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status,
           draft_grace_hours, created_at, updated_at)
         VALUES (?,?,?,?,?,'closed',0,?,?)`,
      )
      .bind(id, programId, `FY202${4 + i} Cycle`, `202${4 + i}-01-01T00:00:00.000Z`,
            `202${4 + i}-03-01T00:00:00.000Z`, now, now)
      .run();
    ids.push(id);
  }
  return ids;
}

async function loadInto(opts: { organizations?: number; applications?: number } = {}) {
  __resetDemoAdminCache();
  const p = await seedProgram(db, ctx(), {
    ...INSPIRE_CHANGE,
    slug: `demo-${Math.random().toString(36).slice(2, 8)}`,
  });
  // Three cycles, because an organization holds one application per cycle and
  // a single-cycle load produces a database where nobody has applied twice.
  const cycleIds = [Object.values(p.cycleIds)[0]!, ...(await extraCycles(p.programId, 2))];
  const result = await loadDemoData(db, ctx(), {
    cycleIds,
    applicationFormId: p.formDefinitionIds.application!,
    plan: buildDemoPlan({ organizations: opts.organizations ?? 12, applications: opts.applications ?? 25 }),
    now: new Date('2026-06-01T00:00:00.000Z'),
  });
  return { ...result, cycleIds, cycleId: cycleIds[0]!, program: p };
}

// ---------------------------------------------------------------------------
describe('the generator', () => {
  it('is deterministic, so a bug found in a demo database is reproducible', () => {
    const a = buildDemoPlan({ organizations: 8, applications: 10, seed: 42 });
    const b = buildDemoPlan({ organizations: 8, applications: 10, seed: 42 });
    expect(a.organizations.map((o) => o.legalName)).toEqual(b.organizations.map((o) => o.legalName));
    expect(a.applications.map((x) => x.status)).toEqual(b.applications.map((x) => x.status));
    // Ids are the one thing that legitimately differs run to run.
    expect(a.organizations[0]!.id).not.toBe(b.organizations[0]!.id);
  });

  it('a different seed produces different data', () => {
    const a = buildDemoPlan({ organizations: 8, applications: 10, seed: 1 });
    const b = buildDemoPlan({ organizations: 8, applications: 10, seed: 2 });
    expect(a.organizations.map((o) => o.legalName)).not.toEqual(b.organizations.map((o) => o.legalName));
  });

  it('invents EINs that could not be real, and addresses that cannot receive mail', () => {
    // If a row ever escapes a demo database it should be obviously invented.
    const orgs = buildOrganizations(40, makeRng(7));
    for (const o of orgs) {
      expect(o.ein, o.legalName).toMatch(/^00\d{7}$/); // the IRS issues no 00 prefix
      expect(o.email, o.legalName).toMatch(/@example-/); // example.* cannot receive mail
    }
    expect(new Set(orgs.map((o) => o.ein)).size).toBe(40);
    expect(new Set(orgs.map((o) => o.legalName)).size).toBe(40);
  });

  it('produces a spread of outcomes weighted the way a real programme is', () => {
    const rng = makeRng(3);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const s = pickStatus(rng);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    // Most applications are declined. That is the shape that matters for
    // decision communication, where 250 declines go out in one week.
    expect(counts.get('declined')! / 4000).toBeGreaterThan(0.45);
    expect(counts.get('awarded')! / 4000).toBeLessThan(0.3);
    for (const s of ['declined', 'awarded', 'under_review', 'submitted', 'withdrawn']) {
      expect(counts.get(s), s).toBeGreaterThan(0);
    }
  });

  it('includes a duplicate organization, because duplicates are inevitable', () => {
    const plan = buildDemoPlan({ organizations: 10, applications: 5, seed: 11 });
    const byEin = new Map<string, number>();
    for (const o of plan.organizations) byEin.set(o.ein, (byEin.get(o.ein) ?? 0) + 1);
    expect([...byEin.values()].some((n) => n > 1)).toBe(true);
    expect(plan.duplicateOf).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('loading it', () => {
  it('every generated application validates against the real form', async () => {
    // The load throws on a validation failure rather than skipping, so this
    // passing IS the assertion: the generator has not drifted from the form.
    const r = await loadInto();
    expect(r.applications).toBeGreaterThan(0);
  });

  it('promotes money as integer cents inside the published range', async () => {
    const r = await loadInto();
    const rows = await db
      .prepare(
        `SELECT requested_amount_cents AS c FROM applications
          WHERE cycle_id IN (SELECT value FROM json_each(?)) AND requested_amount_cents IS NOT NULL`,
      )
      .bind(JSON.stringify(r.cycleIds))
      .all<{ c: number }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(Number.isInteger(row.c)).toBe(true);
      expect(row.c).toBeGreaterThanOrEqual(1_000_000);
      expect(row.c).toBeLessThanOrEqual(5_000_000);
    }
  });

  it('promotes identity onto every row, not just into the answers table', async () => {
    const r = await loadInto();
    const bad = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
          WHERE cycle_id IN (SELECT value FROM json_each(?))
            AND (ein_at_submit IS NULL OR organization_name_at_submit IS NULL
                 OR primary_contact_email IS NULL)`,
      )
      .bind(JSON.stringify(r.cycleIds))
      .first<{ n: number }>();
    expect(bad!.n).toBe(0);
  });

  it('writes an audit row per application', async () => {
    const r = await loadInto();
    const rows = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log a
           JOIN applications ap ON ap.id = a.entity_id
          WHERE ap.cycle_id IN (SELECT value FROM json_each(?)) AND a.action = 'application.submitted'`,
      )
      .bind(JSON.stringify(r.cycleIds))
      .first<{ n: number }>();
    expect(rows!.n).toBe(r.applications);
  });

  it('records a decider for every decided application, as the schema demands', async () => {
    const r = await loadInto();
    const bad = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications
          WHERE cycle_id IN (SELECT value FROM json_each(?)) AND status IN ('awarded','declined')
            AND (decided_at IS NULL OR decided_by IS NULL)`,
      )
      .bind(JSON.stringify(r.cycleIds))
      .first<{ n: number }>();
    expect(bad!.n).toBe(0);
  });

  it('produces repeat applicants, which is what the history panel exists for', async () => {
    // Institutional memory is the point: a reviewer opening an application
    // should see that this organization has applied before and what happened.
    // A single-cycle load makes that impossible, because one organization may
    // hold one application per cycle -- so most of what was generated was
    // silently discarded and nobody ever had a history.
    const r = await loadInto({ organizations: 8, applications: 30 });
    const repeats = await db
      .prepare(
        `SELECT organization_id, COUNT(*) AS n FROM applications
          WHERE cycle_id IN (SELECT value FROM json_each(?))
          GROUP BY organization_id HAVING n > 1`,
      )
      .bind(JSON.stringify(r.cycleIds))
      .all<{ organization_id: string; n: number }>();
    expect(repeats.results.length).toBeGreaterThan(0);

    // And the history reads back through the real staff path.
    const history = await organizationHistoryForStaff(
      db, adminSession(), repeats.results[0]!.organization_id,
    );
    expect(JSON.stringify(history)).toBeTruthy();
  });

  it('reports what it skipped instead of silently dropping it', async () => {
    // The plan deliberately over-generates: more applications than an
    // organization may hold in one cycle, plus a duplicate EIN. Both are
    // REFUSED by real code paths -- the per-cycle limit and the ambiguous-EIN
    // guard -- and a loader that swallowed those would be hiding the two cases
    // this data exists to create.
    const r = await loadInto({ organizations: 6, applications: 20 });
    expect(r.skipped.some((s) => s.reason === 'already_applied_this_cycle')).toBe(true);
    expect(r.applications + r.skipped.reduce((n, s) => n + s.count, 0)).toBe(20);
    // And the count reported matches what is actually in the database.
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM applications WHERE cycle_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(r.cycleIds)).first<{ n: number }>();
    expect(rows!.n).toBe(r.applications);
  });
});

// ---------------------------------------------------------------------------
describe('what the data makes possible', () => {
  it('full-text search distinguishes documents rather than matching everything', async () => {
    // The motivating query in CLAUDE.md only means something if the corpus
    // contains things that are NOT the thing being searched for.
    const r = await loadInto({ organizations: 20, applications: 40 });
    const hits = await searchApplications(db, adminSession(), 'mental health');
    const all = await db
      .prepare(`SELECT COUNT(*) AS n FROM applications WHERE cycle_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(r.cycleIds)).first<{ n: number }>();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(all!.n);
  });

  it('the staff pipeline returns a page of rows with the columns it needs', async () => {
    await loadInto({ organizations: 20, applications: 40 });
    const page = await listApplicationsForStaff(db, adminSession(), {});
    expect(page.applications.length).toBeGreaterThan(10);
    const first = page.applications[0] as Record<string, unknown>;
    expect(first.organization_name_at_submit ?? first.organization_name).toBeTruthy();
    expect(first.status).toBeTruthy();
  });

  it('a reviewer with no assignments still sees nothing, at volume', async () => {
    // Scale must not soften scoping. Non-negotiable 4 does not relax because
    // there are now two hundred rows.
    await loadInto({ organizations: 20, applications: 40 });
    const page = await listApplicationsForStaff(db, reviewerSession(), {});
    expect(page.applications).toHaveLength(0);
    expect(await searchApplications(db, reviewerSession(), 'mental health')).toEqual([]);
  });
});
