import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom, forceDueDatesForAward } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { awardOverview, listAwards } from '../src/lib/awardPage';
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

describe('the grants list', () => {
  it('lists grants newest first, with their reporting state', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Bayou Harbor Trust');
    const a1 = await importedAward({ programId, orgId });
    await generateReportPeriods(db, ctxFor(admin), a1);

    const out = await listAwards(db, admin, { q: 'Bayou Harbor Trust' });
    const row = out.rows.find((r) => r.id === a1);
    expect(row).toBeDefined();
    expect(row!.organizationName).toContain('Bayou Harbor Trust');
    expect(row!.reportsTotal).toBeGreaterThan(0);
    expect(row!.reportsOutstanding).toBeGreaterThan(0);
  });

  it('reports when the grantee last signed in, and an imported account is not a sign-in', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Unreachable Trust');
    const awardId = await importedAward({ programId, orgId });
    const row = async () =>
      (await listAwards(db, admin, { q: 'Unreachable Trust' })).rows.find((r) => r.id === awardId)!;

    expect((await row()).granteeLastSignInAt).toBeNull();

    /*
     * THE BUG THIS REPLACED. The awards importer creates a users row for
     * every imported grant that carried a contact email, so this column --
     * when it asked whether an account EXISTED -- read "can sign in: yes" for
     * all thirteen 2025 grantees, none of whom has ever opened the system.
     * A row created by a spreadsheet is not somebody who can be reached.
     */
    const userId = newId();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
      )
      .bind(userId, `reach-${seq}@example.org`, orgId, nowIso(), nowIso())
      .run();
    expect((await row()).granteeLastSignInAt).toBeNull();

    // Only a real sign-in counts, which is what recordLogin stamps.
    await db
      .prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
      .bind(day('2026-09-28'), userId)
      .run();
    expect((await row()).granteeLastSignInAt).toBe(day('2026-09-28'));
  });

  it('finds a grant by EIN typed with or without its dash', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Dashed');
    const awardId = await importedAward({ programId, orgId });
    const ein = await db
      .prepare(`SELECT ein FROM organizations WHERE id = ?`)
      .bind(orgId)
      .first<{ ein: string }>();

    const dashed = `${ein!.ein.slice(0, 2)}-${ein!.ein.slice(2)}`;
    for (const typed of [ein!.ein, dashed]) {
      const out = await listAwards(db, admin, { q: typed });
      expect(out.rows.map((r) => r.id)).toContain(awardId);
    }
  });

  it('can show only grants with something outstanding', async () => {
    const admin = adminSession();
    const programId = await program();
    const owing = await importedAward({ programId, orgId: await org('Owing') });
    const clear = await importedAward({ programId, orgId: await org('Clear') });
    await generateReportPeriods(db, ctxFor(admin), owing);

    const out = await listAwards(db, admin, { outstandingOnly: true, limit: 500 });
    const ids = out.rows.map((r) => r.id);
    expect(ids).toContain(owing);
    expect(ids).not.toContain(clear);
  });

  it('narrows by program and by status', async () => {
    const admin = adminSession();
    const programId = await program();
    const otherProgram = await program();
    const orgId = await org('Filtered');
    const mine = await importedAward({ programId, orgId });
    const theirs = await importedAward({ programId: otherProgram, orgId: await org('Other') });

    /*
     * Neither filter was asserted anywhere, so deleting either `where.push`
     * passed the whole suite -- on a screen where a filter returning the
     * wrong set reads as the Foundation not having those grants.
     */
    const byProgram = await listAwards(db, admin, { programId, limit: 500 });
    expect(byProgram.rows.map((r) => r.id)).toContain(mine);
    expect(byProgram.rows.map((r) => r.id)).not.toContain(theirs);

    await db.prepare(`UPDATE awards SET status = 'completed' WHERE id = ?`).bind(mine).run();
    const byStatus = await listAwards(db, admin, { status: 'completed', limit: 500 });
    expect(byStatus.rows.map((r) => r.id)).toContain(mine);
    expect(
      (await listAwards(db, admin, { status: 'pending', limit: 500 })).rows.map((r) => r.id),
    ).not.toContain(mine);
  });

  it('counts overdue on the same day the compliance desk does', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Boundary');
    const awardId = await importedAward({ programId, orgId });
    await generateReportPeriods(db, ctxFor(admin), awardId);

    const setDue = (d: string) => forceDueDatesForAward(awardId, d, { status: 'open' });
    const row = async () =>
      (await listAwards(db, admin, { limit: 500 })).rows.find((r) => r.id === awardId)!;

    /*
     * `reportsOverdue` was asserted by no test at all, which is why the
     * boundary bug lived here: the count was `due_date < <full ISO instant>`,
     * and both stored date shapes sort before any same-day timestamp, so a
     * report due TODAY counted as overdue while the desk called it fine.
     */
    const todayUtc = new Date().toISOString().slice(0, 10);
    await setDue(todayUtc);
    expect((await row()).reportsOverdue).toBe(0);
    await setDue(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
    expect((await row()).reportsOverdue).toBe(1);
    // Both stored shapes: generateReportPeriods writes midnight UTC.
    await setDue(`${todayUtc}T00:00:00.000Z`);
    expect((await row()).reportsOverdue).toBe(0);
  });

  it('does not count a refused grant as owing anything', async () => {
    const admin = adminSession();
    const programId = await program();
    const awardId = await importedAward({ programId, orgId: await org('Refused') });
    await generateReportPeriods(db, ctxFor(admin), awardId);
    const row = async () =>
      (await listAwards(db, admin, { limit: 500 })).rows.find((r) => r.id === awardId)!;

    expect((await row()).reportsOutstanding).toBeGreaterThan(0);

    /*
     * A refused award keeps its generated report periods, so counted they put
     * a permanent obligation on a grant nobody took -- unclearable except by
     * waiving a period on a cancelled award. dashboard.ts has excluded them
     * since it was written; these list queries had not.
     */
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(awardId).run();
    expect((await row()).reportsOutstanding).toBe(0);
    expect((await row()).reportsOverdue).toBe(0);
  });

  it('leaves out soft-deleted grants', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Tidy List');
    const gone = await importedAward({ programId, orgId });
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), gone).run();

    const out = await listAwards(db, admin, { q: 'Tidy List' });
    expect(out.rows.map((r) => r.id)).not.toContain(gone);
  });

  it('is refused to everyone but an admin', async () => {
    for (const s of [reviewerSession(), applicantSession(newId())]) {
      expect((await appErrorFrom(listAwards(db, s, {}))).code).toBe('NOT_FOUND');
    }
  });
});
