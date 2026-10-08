import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom, forceDueDatesForAward } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { organizationOverview, listOrganizations } from '../src/lib/organizationPage';
import { organizationHistoryForStaff } from '../src/lib/scope';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * One nonprofit, and everything the Foundation knows about them.
 *
 * The first test below is the reason this module exists at all: it pins the
 * gap in the endpoint this page would otherwise have reused.
 */

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

async function org(name: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, website, mission,
         annual_operating_budget_cents, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
    )
    .bind(
      id, `${name} ${++seq}`, String(910000000 + seq), 'https://example.org',
      'Serving the Greater Houston area.', 125_000_00, now, now,
    )
    .run();
  return id;
}

async function program(): Promise<string> {
  const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `og-${++seq}` });
  return p.programId;
}

/** An award as the importer writes one: no application, no cycle. */
async function award(opts: {
  programId: string;
  orgId: string;
  cents?: number;
  terms?: boolean;
}): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, source_system, source_reference,
         term_start, term_end, created_at, updated_at)
       VALUES (?,NULL,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    )
    .bind(
      id, opts.orgId, opts.programId, opts.cents ?? 2_500_000, day('2025-10-01'),
      `ORG-${id.slice(0, 8)}`,
      opts.terms === false ? null : day('2025-01-01'),
      opts.terms === false ? null : day('2025-12-31'),
      now, now,
    )
    .run();
  return id;
}

async function contact(orgId: string, email: string, primary = true): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO contacts (id, organization_id, first_name, last_name, email,
         job_title, is_primary, created_at, updated_at)
       VALUES (?,?, 'Dana', 'Reyes', ?, 'Director', ?, ?, ?)`,
    )
    .bind(newId(), orgId, email, primary ? 1 : 0, now, now)
    .run();
}

async function granteeUser(orgId: string, email: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
    )
    .bind(id, email, orgId, now, now)
    .run();
  return id;
}

describe('the organization page', () => {
  it('exists because the history endpoint 404s for a funded nonprofit', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Bayou Harbor Trust');
    await award({ programId, orgId });

    /*
     * THE GAP, PINNED. organizationHistoryForStaff gates on the organization
     * having at least one application -- correct for its job, and fatal here:
     * imported grants have none, so every one of the thirteen 2025 grantees
     * answers 404 to an ADMIN. If this ever stops throwing, the gap has been
     * closed elsewhere and this page's reason for existing should be
     * revisited rather than silently kept.
     */
    const err = await appErrorFrom(organizationHistoryForStaff(db, admin, orgId));
    expect(err.code).toBe('NOT_FOUND');

    // And the page this module serves answers properly.
    const out = await organizationOverview(db, admin, orgId);
    expect(out.legalName).toContain('Bayou Harbor Trust');
    expect(out.awards).toHaveLength(1);
  });

  it('sums every grant in integer cents', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Third Ward Futures');
    await award({ programId, orgId, cents: 2_500_000 });
    await award({ programId, orgId, cents: 1_234_567 });

    const out = await organizationOverview(db, admin, orgId);
    // Exact integer arithmetic. 37,345.67 dollars; no float anywhere near it.
    expect(out.totalAwardedCents).toBe(3_734_567);
    expect(Number.isInteger(out.totalAwardedCents)).toBe(true);
  });

  it('distinguishes having an account from ever having used it', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Harrisburg Arts');
    await award({ programId, orgId });

    const before = await organizationOverview(db, admin, orgId);
    expect(before.hasAccount).toBe(false);
    expect(before.lastSignInAt).toBeNull();

    /*
     * THE DISTINCTION THIS EXISTS FOR. The awards importer creates a users
     * row for every imported grant carrying a contact email, so an account
     * existing says only that a spreadsheet named an address. Nobody verified
     * it, nobody there knows of it, and nobody has opened it. Reporting that
     * as "can sign in" answered Yes for all thirteen 2025 grantees.
     */
    const userId = await granteeUser(orgId, `dana-${seq}@example.org`);
    const made = await organizationOverview(db, admin, orgId);
    expect(made.hasAccount).toBe(true);
    expect(made.lastSignInAt).toBeNull();

    await db
      .prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
      .bind(day('2026-09-28'), userId)
      .run();
    const used = await organizationOverview(db, admin, orgId);
    expect(used.lastSignInAt).toBe(day('2026-09-28'));
  });

  it('takes the most recent sign-in when several people have accounts', async () => {
    const admin = adminSession();
    const orgId = await org('Several People');
    const quiet = await granteeUser(orgId, `quiet-${seq}@example.org`);
    const active = await granteeUser(orgId, `active-${seq}@example.org`);

    /*
     * MAX ignores NULLs in SQLite, which is the behaviour relied on: one
     * person at a nonprofit having got in means the nonprofit has been
     * reached, even if two colleagues never have.
     */
    await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
      .bind(day('2026-05-01'), active).run();
    expect((await organizationOverview(db, admin, orgId)).lastSignInAt).toBe(day('2026-05-01'));
    expect(quiet).toBeTruthy();
  });

  it('matches a contact to their login, and the schema is why that is safe', async () => {
    const admin = adminSession();
    const orgId = await org('Sunnyside Food');
    const email = `dana.reyes-${seq}@example.org`;
    await contact(orgId, email);
    await granteeUser(orgId, email);

    const out = await organizationOverview(db, admin, orgId);
    expect(out.contacts).toHaveLength(1);
    expect(out.contacts[0]!.hasAccount).toBe(true);

    /*
     * Contacts and users meet at the email address and nowhere else -- there
     * is no foreign key between them -- so a case mismatch would show a
     * grantee as having no account while they hold a working login, and send
     * somebody chasing a nonprofit who is already in.
     *
     * That cannot happen, and this is why: BOTH tables carry
     * CHECK (email = lower(email)) from 0002. The join is plain equality
     * because of this constraint, so the constraint is asserted here rather
     * than assumed. If either of these stops throwing, the join in
     * organizationPage.ts needs LOWER() on both sides again.
     */
    const mixed = `Dana.Reyes-${seq}@Example.ORG`;
    await expect(contact(orgId, mixed)).rejects.toThrow(/CHECK constraint/);
    await expect(granteeUser(orgId, mixed)).rejects.toThrow(/CHECK constraint/);
  });

  it('reports a grant as overdue only while it is unanswered', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Bayou Bend');
    const awardId = await award({ programId, orgId });
    await generateReportPeriods(db, ctxFor(admin), awardId);
    await forceDueDatesForAward(awardId, day('2024-01-01'));

    const late = await organizationOverview(db, admin, orgId);
    expect(late.awards[0]!.reportsOverdue).toBeGreaterThan(0);
    expect(late.awards[0]!.reportsOutstanding).toBeGreaterThan(0);

    await db
      .prepare(`UPDATE report_periods SET status = 'accepted' WHERE award_id = ?`)
      .bind(awardId)
      .run();
    const settled = await organizationOverview(db, admin, orgId);
    expect(settled.awards[0]!.reportsOverdue).toBe(0);
    expect(settled.awards[0]!.reportsOutstanding).toBe(0);
    expect(settled.awards[0]!.reportsAccepted).toBeGreaterThan(0);
  });

  it('falls back to the email when a contact has no name', async () => {
    const admin = adminSession();
    const orgId = await org('Nameless');
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO contacts (id, organization_id, email, is_primary, created_at, updated_at)
         VALUES (?,?,?,1,?,?)`,
      )
      .bind(newId(), orgId, `anon-${seq}@example.org`, now, now)
      .run();

    // An empty cell under a "Name" heading reads as a broken row. The address
    // identifies them perfectly well.
    const out = await organizationOverview(db, admin, orgId);
    expect(out.contacts[0]!.name).toBe(`anon-${seq}@example.org`);
  });

  it('names the record a merged organization was merged into', async () => {
    const admin = adminSession();
    const survivor = await org('Survivor Trust');
    const duplicate = await org('Duplicate Trust');
    /*
     * status and merged_into_id move together: 0002 has
     * CHECK ((status = 'merged') = (merged_into_id IS NOT NULL)), so half a
     * merge is not a state the database will hold.
     */
    await db
      .prepare(`UPDATE organizations SET merged_into_id = ?, status = 'merged' WHERE id = ?`)
      .bind(survivor, duplicate)
      .run();

    const out = await organizationOverview(db, admin, duplicate);
    expect(out.mergedIntoId).toBe(survivor);
    expect(out.mergedIntoName).toContain('Survivor Trust');
  });

  it('leaves out soft-deleted grants and applications', async () => {
    const admin = adminSession();
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE,
      slug: `og-del-${++seq}`,
    });
    const programId = p.programId;
    const orgId = await org('Tidy');
    const keep = await award({ programId, orgId, cents: 1_000_000 });
    const gone = await award({ programId, orgId, cents: 9_900_000 });
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), gone).run();

    /*
     * The title said "and applications" and no application was ever created,
     * so dropping `a.deleted_at IS NULL` from the applications query passed.
     */
    const cycle = await db.prepare(`SELECT id FROM cycles WHERE program_id = ? LIMIT 1`)
      .bind(programId).first<{ id: string }>();
    const stage = await db
      .prepare(`SELECT id FROM program_stages WHERE program_id = ? ORDER BY sort_order LIMIT 1`)
      .bind(programId).first<{ id: string }>();
    const form = await db
      .prepare(`SELECT id FROM form_definitions WHERE program_id = ? ORDER BY version LIMIT 1`)
      .bind(programId).first<{ id: string }>();
    const now = nowIso();
    const deadApp = newId();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, project_title, submitted_at, created_at, updated_at, deleted_at)
         VALUES (?,?,?,?,?, 'submitted', 'Removed', ?, ?, ?, ?)`,
      )
      .bind(deadApp, cycle!.id, stage!.id, orgId, form!.id, now, now, now, now)
      .run();

    const out = await organizationOverview(db, admin, orgId);
    expect(out.awards.map((a) => a.id)).toEqual([keep]);
    expect(out.applications.map((a) => a.id)).not.toContain(deadApp);
    // And the total must follow the list, or the page shows a figure no row
    // on it adds up to.
    expect(out.totalAwardedCents).toBe(1_000_000);
  });

  it('answers 404 for a soft-deleted organization', async () => {
    const admin = adminSession();
    const orgId = await org('Deleted');
    await db.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`)
      .bind(nowIso(), orgId).run();

    expect((await appErrorFrom(organizationOverview(db, admin, orgId))).code).toBe('NOT_FOUND');
  });

  it('answers 404 for a reviewer, an applicant and a grantee', async () => {
    const programId = await program();
    const orgId = await org('Scoped');
    await award({ programId, orgId });

    /*
     * ADMIN ONLY, and 404 rather than 403 so the refusal reveals nothing.
     * This page carries award amounts, which CLAUDE.md places outside a
     * reviewer's reach without qualification -- including, deliberately, a
     * reviewer assigned to this very organization's application.
     */
    expect((await appErrorFrom(organizationOverview(db, reviewerSession(), orgId))).code)
      .toBe('NOT_FOUND');
    expect((await appErrorFrom(organizationOverview(db, applicantSession(orgId), orgId))).code)
      .toBe('NOT_FOUND');

    const grantee = { userId: newId(), email: 'g@example.org', role: 'grantee' as const, organizationId: orgId };
    expect((await appErrorFrom(organizationOverview(db, grantee, orgId))).code).toBe('NOT_FOUND');
  });
});

describe('the organizations list', () => {
  it('counts grants and applications without multiplying them together', async () => {
    const admin = adminSession();
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE,
      slug: `og-mult-${++seq}`,
    });
    const orgId = await org('Counted Trust');
    await award({ programId: p.programId, orgId, cents: 1_000_000 });
    await award({ programId: p.programId, orgId, cents: 2_000_000 });

    /*
     * TWO GRANTS AND THREE APPLICATIONS, and the three applications are the
     * point. Joining awards and applications to one organization row and
     * grouping multiplies them against each other, so this nonprofit would
     * acquire six grants and a tripled total -- a wrong number on a money
     * column, arrived at silently.
     *
     * The first version of this test created two awards and ZERO
     * applications, so the regression it names could be reintroduced and it
     * would still pass: with no application rows the bad join produces one
     * row per award and every number comes out right.
     */
    /*
     * One application per cycle: a trigger caps an organization at one
     * application in any single cycle, which is correct and means three
     * applications need three cycles. They are in three separate programs
     * here because that is the cheapest way to get them, and the query counts
     * by organization regardless of program.
     */
    const now = nowIso();
    for (let i = 0; i < 3; i++) {
      const other = await seedProgram(db, ctxFor(adminSession()), {
        ...INSPIRE_CHANGE,
        slug: `og-mult-app-${++seq}`,
      });
      const cycle = await db
        .prepare(`SELECT id FROM cycles WHERE program_id = ? LIMIT 1`)
        .bind(other.programId).first<{ id: string }>();
      const stage = await db
        .prepare(`SELECT id FROM program_stages WHERE program_id = ? ORDER BY sort_order LIMIT 1`)
        .bind(other.programId).first<{ id: string }>();
      const form = await db
        .prepare(`SELECT id FROM form_definitions WHERE program_id = ? ORDER BY version LIMIT 1`)
        .bind(other.programId).first<{ id: string }>();
      await db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id,
             form_definition_id, status, project_title, submitted_at, created_at, updated_at)
           VALUES (?,?,?,?,?, 'submitted', ?, ?, ?, ?)`,
        )
        .bind(newId(), cycle!.id, stage!.id, orgId, form!.id, `App ${i}`, now, now, now)
        .run();
    }

    const out = await listOrganizations(db, admin, { q: 'Counted Trust' });
    const row = out.rows.find((r) => r.id === orgId)!;
    expect(row.grants).toBe(2);
    expect(row.applications).toBe(3);
    expect(row.totalAwardedCents).toBe(3_000_000);
  });

  it('counts a report as overdue on the same day the desk does', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Boundary Trust');
    const awardId = await award({ programId, orgId });
    await generateReportPeriods(db, ctxFor(admin), awardId);

    const setDue = (d: string) => forceDueDatesForAward(awardId, d, { status: 'open' });
    const overdue = async () =>
      (await organizationOverview(db, admin, orgId)).awards[0]!.reportsOverdue;

    /*
     * THE BOUNDARY, which is where this was wrong and where no test looked.
     *
     * The count was `due_date < <full ISO instant>`. Due dates are stored
     * either as a plain date or as midnight UTC, and string comparison puts
     * BOTH before any same-day timestamp -- so a report due TODAY counted as
     * overdue here from a millisecond after midnight, while reportDue.ts,
     * which the compliance desk runs, called it zero days out and fine. Two
     * screens one click apart disagreeing about the same grant.
     *
     * The old test used a due date two years past, which pins the sign and
     * nothing else.
     */
    const todayUtc = new Date().toISOString().slice(0, 10);
    const dayOff = (n: number) =>
      new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    await setDue(todayUtc);
    expect(await overdue()).toBe(0);
    await setDue(dayOff(1));
    expect(await overdue()).toBe(0);
    await setDue(dayOff(-1));
    expect(await overdue()).toBe(1);

    // And the midnight-UTC shape generateReportPeriods writes behaves the same.
    await setDue(`${todayUtc}T00:00:00.000Z`);
    expect(await overdue()).toBe(0);
  });

  it('does not count a refused grant as owing anything', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Refused Trust');
    const awardId = await award({ programId, orgId, cents: 4_000_000 });
    await generateReportPeriods(db, ctxFor(admin), awardId);
    await forceDueDatesForAward(awardId, day('2024-01-01'));

    expect((await organizationOverview(db, admin, orgId)).awards[0]!.reportsOverdue).toBe(1);

    /*
     * A GRANT NOBODY TOOK OWES NOTHING. 0020 records a refused award as
     * cancelled and leaves its generated report periods alone, so counting
     * them puts a permanent red row against a nonprofit for a grant they
     * declined -- unclearable except by waiving a period on a cancelled
     * award. dashboard.ts has excluded them since it was written.
     */
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(awardId).run();
    const after = await organizationOverview(db, admin, orgId);
    expect(after.awards[0]!.reportsOverdue).toBe(0);
    expect(after.awards[0]!.reportsOutstanding).toBe(0);
    // And the money is not committed either, which is what the dashboard says.
    expect(after.totalAwardedCents).toBe(0);

    const listed = await listOrganizations(db, admin, { q: 'Refused Trust' });
    expect(listed.rows[0]!.reportsOverdue).toBe(0);
    expect(listed.rows[0]!.totalAwardedCents).toBe(0);
  });

  it('treats a waived report as settled, not as missing', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Waived Trust');
    const awardId = await award({ programId, orgId });
    await generateReportPeriods(db, ctxFor(admin), awardId);

    /*
     * Waiving is a deliberate act with a reason, and it settles the
     * obligation -- dashboard.ts counts accepted and waived together. Counting
     * only `accepted` made a grant with nothing outstanding read "0 of 1
     * accepted", which reads as a missing report.
     */
    await db
      .prepare(`UPDATE report_periods SET status = 'waived', waived_reason = 'Closed early'
                 WHERE award_id = ?`)
      .bind(awardId)
      .run();
    const out = await organizationOverview(db, admin, orgId);
    expect(out.awards[0]!.reportsOutstanding).toBe(0);
    expect(out.awards[0]!.reportsAccepted).toBe(out.awards[0]!.reportsTotal);
  });

  it('finds the funded nonprofits nobody has ever signed in from', async () => {
    const admin = adminSession();
    const programId = await program();

    const stranded = await org('Stranded Trust');
    await award({ programId, orgId: stranded });

    /*
     * AN IMPORTED ACCOUNT DOES NOT COUNT, and this is the case that broke the
     * filter before: the awards importer makes a users row for every imported
     * grant, so a filter keyed on "has an account" matched nothing at all.
     */
    const imported = await org('Imported Account Trust');
    await award({ programId, orgId: imported });
    await granteeUser(imported, `imported-${seq}@example.org`);

    const reached = await org('Reached Trust');
    await award({ programId, orgId: reached });
    const reachedUser = await granteeUser(reached, `reach-${seq}@example.org`);
    await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
      .bind(day('2026-09-28'), reachedUser).run();

    // Never funded: not a problem, and must not appear however quiet they are.
    const applicantOnly = await org('Applicant Only');

    const out = await listOrganizations(db, admin, { neverSignedInOnly: true, limit: 500 });
    const ids = out.rows.map((r) => r.id);
    expect(ids).toContain(stranded);
    expect(ids).toContain(imported);
    expect(ids).not.toContain(reached);
    expect(ids).not.toContain(applicantOnly);
  });

  it('reports zero rather than null for a nonprofit with no grants', async () => {
    const admin = adminSession();
    const orgId = await org('Never Funded');

    // COALESCE on the sum, because SUM over no rows is NULL and a null total
    // renders as a blank cell in a money column, which reads as missing data
    // rather than as nothing.
    const out = await listOrganizations(db, admin, { q: 'Never Funded' });
    const row = out.rows.find((r) => r.id === orgId)!;
    expect(row.grants).toBe(0);
    expect(row.totalAwardedCents).toBe(0);
    expect(row.lastAwardedAt).toBeNull();
  });

  it('finds a nonprofit by EIN typed either way', async () => {
    const admin = adminSession();
    const orgId = await org('Dashed Org');
    const ein = await db
      .prepare(`SELECT ein FROM organizations WHERE id = ?`)
      .bind(orgId)
      .first<{ ein: string }>();

    for (const typed of [ein!.ein, `${ein!.ein.slice(0, 2)}-${ein!.ein.slice(2)}`]) {
      const out = await listOrganizations(db, admin, { q: typed });
      expect(out.rows.map((r) => r.id)).toContain(orgId);
    }
  });

  it('leaves out soft-deleted organizations', async () => {
    const admin = adminSession();
    const orgId = await org('Deleted Org');
    await db.prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`)
      .bind(nowIso(), orgId).run();

    const out = await listOrganizations(db, admin, { q: 'Deleted Org' });
    expect(out.rows.map((r) => r.id)).not.toContain(orgId);
  });

  it('is refused to everyone but an admin', async () => {
    for (const s of [reviewerSession(), applicantSession(newId())]) {
      expect((await appErrorFrom(listOrganizations(db, s, {}))).code).toBe('NOT_FOUND');
    }
  });
});
