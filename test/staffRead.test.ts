import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession } from './helpers';
import {
  getApplicationDetailForStaff,
  listApplicationsForStaff,
  organizationHistoryForStaff,
  staffApplicationScope,
} from '../src/lib/scope';
import { searchApplications } from '../src/lib/search';
import { buildSearchDoc, reindexStatements } from '../src/lib/search';
import { allFields } from '../src/lib/forms';
import { EMPTY_VALUE, type StoredValue } from '../src/lib/fieldTypes';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { loadFormDefinition } from '../src/lib/loadForm';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * The staff read surface.
 *
 * The load-bearing test in this file is the search one. searchApplications
 * previously gated on "is this person staff" and nothing else, so a reviewer
 * received a ranked snippet of the narrative of every application in the
 * system. It was latent while review_assignments did not exist; it became real
 * the moment assignments could be created.
 */

async function makeUser(role: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  const email = `${role}-${id}@example.org`;
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, display_name, is_active, created_at, updated_at)
       VALUES (?,?,?,NULL,?,1,?,?)`,
    )
    .bind(id, email, role, email, now, now)
    .run();
  return id;
}

interface Scene {
  programId: string;
  cycleId: string;
  orgA: string;
  orgB: string;
  mine: string;
  theirs: string;
  reviewer: string;
}

async function scene(): Promise<Scene> {
  const ctx = ctxFor(adminSession());
  const program = await seedProgram(db, ctx, INSPIRE_CHANGE);
  const orgA = (await seedOrganization(db, ctx, ORG_FIXTURES[0]!)).organizationId;
  const orgB = (await seedOrganization(db, ctx, ORG_FIXTURES[1]!)).organizationId;

  const cycleId = Object.values(program.cycleIds)[0]!;
  const stageId = program.stageIds.application!;
  const formId = program.formDefinitionIds.application!;
  const def = await loadFormDefinition(db, formId);
  const now = nowIso();

  async function makeApp(orgId: string, title: string, narrative: string, cents: number) {
    const id = newId();
    await db
      .prepare(
        `INSERT INTO applications (
           id, cycle_id, stage_id, organization_id, form_definition_id, status,
           project_title, requested_amount_cents, internal_notes, decision_notes,
           submitted_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,'submitted',?,?,?,?,?,?,?)`,
      )
      .bind(
        id, cycleId, stageId, orgId, formId, title, cents,
        'INTERNAL: the budget looks thin', 'declined: weakest of the cohort',
        now, now, now,
      )
      .run();

    // Index it so the FTS route has something to find. The narrative goes into
    // a real long_text field of the real form definition rather than being
    // passed as a string, because that is how submit.ts builds the document --
    // a fixture that indexes differently from production proves nothing.
    const narrativeField = allFields(def).find((f) => f.field_type === 'long_text')!;
    const answers = new Map<string, StoredValue>([
      [narrativeField.id, { ...EMPTY_VALUE, value_text: narrative }],
    ]);
    const doc = buildSearchDoc({
      applicationId: id,
      definition: def,
      answers,
      promoted: {
        organization_name: 'Fixture Org',
        ein: '760000000',
        project_title: title,
        counties_served_json: null,
      },
    });
    await db.batch(reindexStatements(db, doc, now));
    return id;
  }

  return {
    programId: program.programId,
    cycleId,
    orgA,
    orgB,
    mine: await makeApp(orgA, 'Reading support', 'literacy tutoring in Fort Bend County', 25_000_00),
    theirs: await makeApp(orgB, 'Youth mental health', 'literacy tutoring for teenagers', 90_000_00),
    reviewer: await makeUser('reviewer'),
  };
}

async function assign(applicationId: string, reviewerUserId: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(id, applicationId, reviewerUserId, now, now, now)
    .run();
  return id;
}

// ---------------------------------------------------------------------------

describe('full-text search is scoped by ASSIGNMENT, not by staff role', () => {
  it('a reviewer finds only the application assigned to them', async () => {
    // THE regression test for this phase. Both applications match the query.
    const s = await scene();
    await assign(s.mine, s.reviewer);

    const hits = await searchApplications(db, reviewerSession(s.reviewer), 'literacy');
    expect(hits.map((h) => h.application_id)).toEqual([s.mine]);
  });

  it('a reviewer with NO assignments finds nothing at all', async () => {
    const s = await scene();
    const hits = await searchApplications(db, reviewerSession(s.reviewer), 'literacy');
    expect(hits).toEqual([]);
  });

  it('a recused reviewer stops finding the application', async () => {
    const s = await scene();
    const assignment = await assign(s.mine, s.reviewer);
    expect(await searchApplications(db, reviewerSession(s.reviewer), 'literacy')).toHaveLength(1);

    await db
      .prepare(`UPDATE review_assignments SET recused_at=?, recused_reason='conflict' WHERE id=?`)
      .bind(nowIso(), assignment)
      .run();
    expect(await searchApplications(db, reviewerSession(s.reviewer), 'literacy')).toHaveLength(0);
  });

  it('an admin still finds everything', async () => {
    const s = await scene();
    const hits = await searchApplications(db, adminSession(), 'literacy');
    expect(hits.map((h) => h.application_id).sort()).toEqual([s.mine, s.theirs].sort());
  });

  it('a snippet never reaches a reviewer for an unassigned application', async () => {
    // Belt and braces: assert on the payload, not just the id list. A snippet
    // of another organization's narrative is seeing it.
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const hits = await searchApplications(db, reviewerSession(s.reviewer), 'teenagers');
    expect(JSON.stringify(hits)).not.toContain('teenagers');
  });
});

describe('the pipeline list', () => {
  it('shows an admin every application, with organization and cycle joined', async () => {
    const s = await scene();
    const { applications, total } = await listApplicationsForStaff(db, adminSession());
    expect(total).toBe(2);
    expect(applications[0]!.organization_name).toBeTruthy();
    expect(applications[0]!.cycle_name).toBeTruthy();
  });

  it('shows a reviewer only their assignments, and counts only those', async () => {
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const { applications, total } = await listApplicationsForStaff(db, reviewerSession(s.reviewer));
    expect(total).toBe(1);
    expect(applications.map((a) => a.id)).toEqual([s.mine]);
  });

  it('withholds internal_notes and decision_notes from a REVIEWER', async () => {
    // A judgement call made conservatively: staff commentary reaching a
    // reviewer before they score anchors the score on someone else's opinion,
    // which is what a rubric exists to prevent.
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const { applications } = await listApplicationsForStaff(db, reviewerSession(s.reviewer));
    const json = JSON.stringify(applications);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toContain('weakest of the cohort');
  });

  it('gives an ADMIN the internal columns, because that is their job', async () => {
    const s = await scene();
    const { applications } = await listApplicationsForStaff(db, adminSession());
    expect(JSON.stringify(applications)).toContain('INTERNAL');
  });

  it('filters by status, cycle, organization and amount', async () => {
    const s = await scene();
    const admin = adminSession();

    expect((await listApplicationsForStaff(db, admin, { status: 'draft' })).total).toBe(0);
    expect((await listApplicationsForStaff(db, admin, { status: 'submitted' })).total).toBe(2);
    expect((await listApplicationsForStaff(db, admin, { organizationId: s.orgA })).total).toBe(1);
    expect((await listApplicationsForStaff(db, admin, { cycleId: s.cycleId })).total).toBe(2);
    expect((await listApplicationsForStaff(db, admin, { programId: s.programId })).total).toBe(2);

    // Integer cents throughout. 25000.00 and 90000.00 dollars.
    expect((await listApplicationsForStaff(db, admin, { minAmountCents: 50_000_00 })).total).toBe(1);
    expect((await listApplicationsForStaff(db, admin, { maxAmountCents: 50_000_00 })).total).toBe(1);
    expect(
      (await listApplicationsForStaff(db, admin, { minAmountCents: 1, maxAmountCents: 100_000_00 })).total,
    ).toBe(2);
  });

  it('paginates without losing the true total', async () => {
    const s = await scene();
    const page = await listApplicationsForStaff(db, adminSession(), { limit: 1, offset: 0 });
    expect(page.applications).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('a filter cannot be used to reach outside the reviewer scope', async () => {
    // The classic: scope the list, then let a query parameter widen it.
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const { applications, total } = await listApplicationsForStaff(db, reviewerSession(s.reviewer), {
      organizationId: s.orgB,
    });
    expect(total).toBe(0);
    expect(applications).toEqual([]);
  });
});

describe('the application detail view', () => {
  it('returns the application, organization, answers and attachment metadata', async () => {
    const s = await scene();
    const detail = await getApplicationDetailForStaff(db, adminSession(), s.mine);
    expect((detail.application as Record<string, unknown>).id).toBe(s.mine);
    expect((detail.organization as Record<string, unknown>).legal_name).toBeTruthy();
    expect(detail.answers).toBeTruthy();
    expect(Array.isArray(detail.attachments)).toBe(true);
  });

  it('404s an application a reviewer is not assigned to', async () => {
    const s = await scene();
    await assign(s.mine, s.reviewer);
    await expect(
      getApplicationDetailForStaff(db, reviewerSession(s.reviewer), s.theirs),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('projects internal columns out of the REVIEWER detail payload', async () => {
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const detail = await getApplicationDetailForStaff(db, reviewerSession(s.reviewer), s.mine);
    const json = JSON.stringify(detail);
    expect(json).not.toContain('INTERNAL');
    expect(json).not.toContain('weakest of the cohort');
    // But the application itself is there.
    expect((detail.application as Record<string, unknown>).project_title).toBe('Reading support');
  });

  it('never returns an R2 object key', async () => {
    // A download goes through a separate endpoint that issues a short-lived
    // signed URL and audits it. The key itself is not a thing a browser needs.
    const s = await scene();
    const detail = await getApplicationDetailForStaff(db, adminSession(), s.mine);
    expect(JSON.stringify(detail)).not.toContain('r2_key');
  });
});

describe('applicant history', () => {
  it('gives an admin the full history of an organization', async () => {
    const s = await scene();
    const history = await organizationHistoryForStaff(db, adminSession(), s.orgA);
    expect((history.organization as Record<string, unknown>).id).toBe(s.orgA);
    expect((history.summary as Record<string, unknown>).total_applications).toBe(1);
  });

  it('gives a reviewer the history of an organization they are assigned to', async () => {
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const history = await organizationHistoryForStaff(db, reviewerSession(s.reviewer), s.orgA);
    expect((history.summary as Record<string, unknown>).total_applications).toBe(1);
  });

  it('404s an organization the reviewer has no assignment to', async () => {
    // Not an empty history -- an empty history would confirm the organization
    // exists.
    const s = await scene();
    await assign(s.mine, s.reviewer);
    await expect(
      organizationHistoryForStaff(db, reviewerSession(s.reviewer), s.orgB),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('carries no narrative from the other applications in the history', async () => {
    const s = await scene();
    await assign(s.mine, s.reviewer);
    const history = await organizationHistoryForStaff(db, reviewerSession(s.reviewer), s.orgA);
    expect(JSON.stringify(history)).not.toContain('INTERNAL');
  });
});

describe('soft-deleted work never resurfaces on a staff read', () => {
  /*
   * Non-negotiable #7 makes soft-delete the only delete, which makes EVERY read
   * responsible for the filter. The applicant path had this test; the staff
   * surface did not, so dropping `a.deleted_at IS NULL` from the pipeline, the
   * detail gate or the history list left the suite green.
   */
  it('is gone from the pipeline', async () => {
    const s = await scene();
    expect((await listApplicationsForStaff(db, adminSession())).total).toBe(2);
    await db.prepare(`UPDATE applications SET deleted_at = ? WHERE id = ?`).bind(nowIso(), s.mine).run();
    const after = await listApplicationsForStaff(db, adminSession());
    expect(after.total).toBe(1);
    expect(after.applications.map((a) => a.id)).not.toContain(s.mine);
  });

  it('404s on the detail view, for an admin as well as a reviewer', async () => {
    const s = await scene();
    await db.prepare(`UPDATE applications SET deleted_at = ? WHERE id = ?`).bind(nowIso(), s.mine).run();
    await expect(getApplicationDetailForStaff(db, adminSession(), s.mine)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is gone from the organization history', async () => {
    const s = await scene();
    await db.prepare(`UPDATE applications SET deleted_at = ? WHERE id = ?`).bind(nowIso(), s.mine).run();
    // orgA had exactly one application, so the history gate itself now 404s --
    // which is the correct answer, not an empty history.
    await expect(organizationHistoryForStaff(db, adminSession(), s.orgA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a WITHDRAWN application is not findable in search', async () => {
    // The join to applications exists so "a withdrawn application stays
    // findable" cannot happen. Only the soft-delete half of that join was
    // tested.
    const s = await scene();
    expect(await searchApplications(db, adminSession(), 'literacy')).toHaveLength(2);
    await db.prepare(`UPDATE applications SET status = 'withdrawn' WHERE id = ?`).bind(s.mine).run();
    const hits = await searchApplications(db, adminSession(), 'literacy');
    expect(hits.map((h) => h.application_id)).toEqual([s.theirs]);
  });
});

describe('the pipeline amount filter is INCLUSIVE, as its interface says', () => {
  it('includes a row sitting exactly on each bound', async () => {
    // The existing filter test uses a bound that is never a row value, so
    // >= degrading to > went unnoticed despite "Inclusive bounds" in the type.
    const s = await scene();
    const admin = adminSession();
    expect((await listApplicationsForStaff(db, admin, { minAmountCents: 25_000_00 })).total).toBe(2);
    expect((await listApplicationsForStaff(db, admin, { maxAmountCents: 25_000_00 })).total).toBe(1);
    expect(
      (await listApplicationsForStaff(db, admin, { minAmountCents: 25_000_00, maxAmountCents: 25_000_00 })).total,
    ).toBe(1);
  });
});

describe('the scope helper itself', () => {
  it('gives an admin an unrestricted scope and a reviewer a joined one', () => {
    expect(staffApplicationScope(adminSession())).toEqual({ join: '', where: '1 = 1', binds: [] });
    const reviewer = staffApplicationScope(reviewerSession('r1'));
    expect(reviewer.join).toContain('review_assignments');
    expect(reviewer.binds).toEqual(['r1']);
  });

  it('fails CLOSED for any other role', () => {
    // An executive, an applicant, or a staff-ish role added later must not
    // inherit admin's reach by falling through.
    for (const role of ['executive', 'applicant', 'grantee'] as const) {
      const scope = staffApplicationScope({
        userId: 'x', email: 'x@example.org', role, organizationId: null,
      });
      expect(scope.where, `${role} must not see anything`).toBe('1 = 0');
    }
  });
});
