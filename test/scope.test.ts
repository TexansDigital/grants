import { describe, it, expect } from 'vitest';
import { db, ctxFor, applicantSession, adminSession, reviewerSession } from './helpers';
import {
  getApplicationForExternal,
  listApplicationsForExternal,
  getApplicationForStaff,
  assertNoInternalFields,
  APPLICANT_APPLICATION_COLUMNS,
  INTERNAL_ONLY_COLUMNS,
} from '../src/lib/scope';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * Definition of done #2. These are the tests that must never be allowed to go
 * red. A failure here means one nonprofit can read another nonprofit's audited
 * financial statements.
 */
async function scenario() {
  const ctx = ctxFor(adminSession());
  const program = await seedProgram(db, ctx, INSPIRE_CHANGE);
  const orgA = await seedOrganization(db, ctx, ORG_FIXTURES[0]!);
  const orgB = await seedOrganization(db, ctx, ORG_FIXTURES[1]!);

  const cycleId = Object.values(program.cycleIds)[0]!;
  const stageId = program.stageIds.application!;
  const formId = program.formDefinitionIds.application!;
  const now = nowIso();

  async function makeApp(organizationId: string): Promise<string> {
    const id = newId();
    await db
      .prepare(
        `INSERT INTO applications (
           id, cycle_id, stage_id, organization_id, form_definition_id, status,
           internal_notes, decision_notes, submission_ip, submission_user_agent,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, cycleId, stageId, organizationId, formId, 'draft',
        'REVIEWER SAID THE BUDGET IS THIN', 'declined: weakest of the cohort',
        '203.0.113.9', 'Mozilla/5.0', now, now,
      )
      .run();
    return id;
  }

  return { orgA, orgB, appA: await makeApp(orgA.organizationId), appB: await makeApp(orgB.organizationId) };
}

describe('organization scoping', () => {
  it('returns an application to its own organization', async () => {
    const s = await scenario();
    const row = await getApplicationForExternal(
      db,
      applicantSession(s.orgA.organizationId),
      s.appA,
    );
    expect(row.id).toBe(s.appA);
  });

  it('returns 404, not 403, when an id from the URL belongs to another organization', async () => {
    const s = await scenario();
    // Org A's session asking for Org B's application id: the exact attack the
    // rule exists to stop. It must look identical to a nonexistent record.
    await expect(
      getApplicationForExternal(db, applicantSession(s.orgA.organizationId), s.appB),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('returns 404 for an id that does not exist at all, indistinguishable from the above', async () => {
    const s = await scenario();
    await expect(
      getApplicationForExternal(db, applicantSession(s.orgA.organizationId), newId()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('lists only the session organization own applications', async () => {
    const s = await scenario();
    const rows = await listApplicationsForExternal(db, applicantSession(s.orgA.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(s.appA);
  });

  it('ignores any organization id that is not on the session', async () => {
    const s = await scenario();
    // There is deliberately no parameter to pass a different org through. This
    // asserts the shape: the only input is the session and the record id.
    const rows = await listApplicationsForExternal(db, applicantSession(s.orgB.organizationId));
    expect(rows.map((r) => r.id)).toEqual([s.appB]);
  });
});

describe('internal fields are absent from external payloads', () => {
  it('omits internal_notes, decision_notes, and submission metadata', async () => {
    const s = await scenario();
    const row = await getApplicationForExternal(
      db,
      applicantSession(s.orgA.organizationId),
      s.appA,
    );
    const keys = Object.keys(row);

    // Not "undefined". Not "empty string". ABSENT.
    expect(keys).not.toContain('internal_notes');
    expect(keys).not.toContain('decision_notes');
    expect(keys).not.toContain('decided_by');
    expect(keys).not.toContain('submission_ip');
    expect(keys).not.toContain('submission_user_agent');

    // And the serialized payload contains none of the internal text.
    const json = JSON.stringify(row);
    expect(json).not.toContain('REVIEWER SAID');
    expect(json).not.toContain('weakest of the cohort');
    expect(json).not.toContain('203.0.113.9');
  });

  it('the applicant allowlist and the internal denylist never overlap', () => {
    const allow = new Set<string>(APPLICANT_APPLICATION_COLUMNS);
    for (const c of INTERNAL_ONLY_COLUMNS) {
      expect(allow.has(c), `${c} must not be in the applicant allowlist`).toBe(false);
    }
  });

  it('assertNoInternalFields catches a leak at any nesting depth', () => {
    expect(() => assertNoInternalFields({ id: 'a', nested: { ok: 1 } })).not.toThrow();
    expect(() => assertNoInternalFields({ id: 'a', internal_notes: 'x' })).toThrow(/internal-only/);
    expect(() =>
      assertNoInternalFields({ items: [{ id: 'a' }, { deep: { score: 5 } }] }),
    ).toThrow(/internal-only/);
  });
});

describe('staff scoping', () => {
  it('lets an admin read any application', async () => {
    const s = await scenario();
    const row = await getApplicationForStaff(db, adminSession(), s.appB);
    expect(row.id).toBe(s.appB);
  });

  it('fails closed for a reviewer while no assignment table exists', async () => {
    const s = await scenario();
    // Phase 3 adds review_assignments. Until then a reviewer sees nothing,
    // which is the safe direction to be wrong in.
    await expect(getApplicationForStaff(db, reviewerSession(), s.appA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('gives an executive no in-app access at all', async () => {
    const s = await scenario();
    await expect(
      getApplicationForStaff(
        db,
        { userId: 'x', email: 'e@example.org', role: 'executive', organizationId: null },
        s.appA,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('session integrity', () => {
  it('refuses to derive an organization scope for an internal role', async () => {
    await expect(getApplicationForExternal(db, adminSession(), 'anything')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an external session with no organization', async () => {
    await expect(
      getApplicationForExternal(
        db,
        { userId: 'u', email: 'a@example.org', role: 'applicant', organizationId: null },
        'anything',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
