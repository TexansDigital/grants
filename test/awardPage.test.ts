import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { awardOverview } from '../src/lib/awardPage';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * One grant, on one page.
 *
 * THE CASE THAT MATTERS MOST IS THE ONE WITH NO APPLICATION. Every award
 * screen in this system was mounted inside the application detail view, and
 * imported awards have `application_id = NULL` -- so the thirteen 2025
 * Inspire Change grants, the entire reason for this launch, had no page. Half
 * of what is below is there to make sure this one renders without an
 * application and never phrases anything as though one exists.
 */

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

async function org(name: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(id, `${name} ${++seq}`, String(890000000 + seq), now, now)
    .run();
  return id;
}

/** An award as the importer writes one: no application, no cycle. */
async function importedAward(opts: {
  programId: string;
  orgId: string;
  terms?: boolean;
  parentId?: string;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, source_system, source_reference,
         term_start, term_end, parent_award_id, created_at, updated_at)
       VALUES (?,NULL,?,?,?,?,'active','spreadsheet',?,?,?,?,?,?)`,
    )
    .bind(
      id, opts.orgId, opts.programId, 3_500_000, day('2025-10-01'),
      `IMP-${id.slice(0, 8)}`,
      opts.terms === false ? null : day('2025-01-01'),
      opts.terms === false ? null : day('2025-12-31'),
      opts.parentId ?? null, now, now,
    )
    .run();
  return id;
}

async function program(): Promise<string> {
  const p = await seedProgram(db, ctxFor(adminSession()), {
    ...INSPIRE_CHANGE,
    slug: `aw-${++seq}`,
  });
  return p.programId;
}

describe('the award page', () => {
  it('renders an imported grant that has no application', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Bayou Harbor Trust');
    const awardId = await importedAward({ programId, orgId });

    const out = await awardOverview(db, admin, awardId);
    expect(out.awardId).toBe(awardId);
    // The field exists and is null, rather than the page failing to assemble.
    // This is the normal state for all thirteen, not an edge case.
    expect(out.applicationId).toBeNull();
    expect(out.projectTitle).toBeNull();
    expect(out.cycleId).toBeNull();
    expect(out.organizationName).toContain('Bayou Harbor Trust');
    expect(out.awardedAmountCents).toBe(3_500_000);
    expect(out.sourceSystem).toBe('spreadsheet');
  });

  it('links the application when there is one', async () => {
    const admin = adminSession();
    const adminCtx = ctxFor(admin);
    const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `aw-app-${++seq}` });
    const orgId = await org('Harrisburg Arts');
    const now = nowIso();

    const cycle = await db
      .prepare(`SELECT id FROM cycles WHERE program_id = ? LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();
    const stage = await db
      .prepare(`SELECT id FROM program_stages WHERE program_id = ? ORDER BY sort_order LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();

    const form = await db
      .prepare(`SELECT id FROM form_definitions WHERE program_id = ? ORDER BY version LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();

    const appId = newId();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, project_title, submitted_at, created_at, updated_at)
         VALUES (?,?,?,?,?, 'submitted', 'After-school reading', ?, ?, ?)`,
      )
      .bind(appId, cycle!.id, stage!.id, orgId, form!.id, now, now, now)
      .run();

    const awardId = newId();
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id, cycle_id,
           awarded_amount_cents, awarded_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .bind(awardId, appId, orgId, p.programId, cycle!.id, 1_000_000, now, now, now)
      .run();

    const out = await awardOverview(db, admin, awardId);
    expect(out.applicationId).toBe(appId);
    expect(out.projectTitle).toBe('After-school reading');
    expect(out.cycleId).toBe(cycle!.id);
  });

  it('still renders when the application was soft-deleted', async () => {
    const admin = adminSession();
    const adminCtx = ctxFor(admin);
    const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `aw-del-${++seq}` });
    const orgId = await org('Sunnyside Food');
    const now = nowIso();
    const cycle = await db
      .prepare(`SELECT id FROM cycles WHERE program_id = ? LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();
    const stage = await db
      .prepare(`SELECT id FROM program_stages WHERE program_id = ? ORDER BY sort_order LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();

    const form = await db
      .prepare(`SELECT id FROM form_definitions WHERE program_id = ? ORDER BY version LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();

    const appId = newId();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, project_title, submitted_at, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?, 'submitted', 'Gone', ?, ?, ?, ?)`,
      )
      .bind(appId, cycle!.id, stage!.id, orgId, form!.id, now, now, now, now)
      .run();

    const awardId = newId();
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id,
           awarded_amount_cents, awarded_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .bind(awardId, appId, orgId, p.programId, 500_000, now, now, now)
      .run();

    /*
     * The award must survive its application being deleted. A financial record
     * vanishing from the system because a different record was soft-deleted
     * would be the worst possible reading of "nothing is hard-deleted".
     */
    const out = await awardOverview(db, admin, awardId);
    expect(out.awardId).toBe(awardId);
    expect(out.projectTitle).toBeNull();
  });

  it('says WHY there are no reports, and distinguishes the two reasons', async () => {
    const admin = adminSession();
    const programId = await program();

    const noTerms = await importedAward({ programId, orgId: await org('No Terms'), terms: false });
    expect((await awardOverview(db, admin, noTerms)).whyNoReports).toBe('no_term_dates');

    // With terms, generation is possible and simply has not been asked for.
    // Different reason, different next step: amend the award, or request the
    // update. A blank section that does not say which is useless.
    const withTerms = await importedAward({ programId, orgId: await org('With Terms') });
    expect((await awardOverview(db, admin, withTerms)).whyNoReports).toBe('not_requested');

    await generateReportPeriods(db, ctxFor(admin), withTerms);
    const after = await awardOverview(db, admin, withTerms);
    expect(after.whyNoReports).toBe('has_reports');
    expect(after.reports.length).toBeGreaterThan(0);
  });

  it('shows the report obligations of this award and no other', async () => {
    const admin = adminSession();
    const programId = await program();
    const mine = await importedAward({ programId, orgId: await org('Mine') });
    const theirs = await importedAward({ programId, orgId: await org('Theirs') });
    await generateReportPeriods(db, ctxFor(admin), mine);
    await generateReportPeriods(db, ctxFor(admin), theirs);

    const out = await awardOverview(db, admin, mine);
    expect(out.reports.length).toBeGreaterThan(0);
    expect(out.reports.every((r) => r.awardId === mine)).toBe(true);
  });

  it('links a renewal to its parent, in both directions', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Third Ward Futures');
    const first = await importedAward({ programId, orgId });
    const second = await importedAward({ programId, orgId, parentId: first });

    const parentView = await awardOverview(db, admin, first);
    expect(parentView.parent).toBeNull();
    expect(parentView.renewals.map((r) => r.id)).toEqual([second]);

    const childView = await awardOverview(db, admin, second);
    expect(childView.parent?.id).toBe(first);
    expect(childView.renewals).toEqual([]);
  });

  it('reads SQLite integers as real booleans', async () => {
    const admin = adminSession();
    const programId = await program();
    const awardId = await importedAward({ programId, orgId: await org('Flags') });

    const before = await awardOverview(db, admin, awardId);
    expect(before.isPublic).toBe(false);
    expect(before.isMultiYear).toBe(false);

    await db.prepare(`UPDATE awards SET is_public = 1, is_multi_year = 1 WHERE id = ?`)
      .bind(awardId).run();
    const after = await awardOverview(db, admin, awardId);
    expect(after.isPublic).toBe(true);
    expect(after.isMultiYear).toBe(true);
  });

  it('answers 404 for a soft-deleted award', async () => {
    const admin = adminSession();
    const programId = await program();
    const awardId = await importedAward({ programId, orgId: await org('Deleted') });
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), awardId).run();

    const err = await appErrorFrom(awardOverview(db, admin, awardId));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('answers 404 for a reviewer, never 403', async () => {
    const programId = await program();
    const awardId = await importedAward({ programId, orgId: await org('Scoped') });

    /*
     * NOT_FOUND rather than FORBIDDEN, because the distinction is itself a
     * disclosure: a reviewer who gets 403 on one id and 404 on another has
     * been told which awards exist. This page carries another organization's
     * payment schedule and paperwork status, so it answers the same way to
     * everyone who may not have it.
     */
    const err = await appErrorFrom(awardOverview(db, reviewerSession(), awardId));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('answers 404 for an applicant and a grantee', async () => {
    const programId = await program();
    const orgId = await org('External');
    const awardId = await importedAward({ programId, orgId });

    expect((await appErrorFrom(awardOverview(db, applicantSession(orgId), awardId))).code)
      .toBe('NOT_FOUND');

    // And a grantee OF THIS VERY AWARD gets nothing: this is the staff page,
    // carrying internal status and amendment history. Their own view of the
    // award is the portal, which is a different payload entirely.
    const grantee = { userId: newId(), email: 'g@example.org', role: 'grantee' as const, organizationId: orgId };
    expect((await appErrorFrom(awardOverview(db, grantee, awardId))).code).toBe('NOT_FOUND');
  });
});
