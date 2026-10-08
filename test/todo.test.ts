import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom, forceDueDate } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { todo, REPORT_HORIZON_DAYS } from '../src/lib/todo';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * The one list that says whether anything is outstanding.
 *
 * TWO PROPERTIES CARRY THE WHOLE SCREEN, and both are tested here.
 *
 * 1. An empty list means nothing is outstanding. If a kind of obligation can
 *    exist and not appear, the list is worse than no list -- it is a promise
 *    that was not kept, and the person stops opening the other tabs.
 *
 * 2. It does not widen access. Two of its three sources are ADMIN_ONLY routes
 *    (/api/grantee-claims and /api/retention) and the endpoint serving this is
 *    STAFF_READ, so a reviewer -- including an outside consultant hired for one
 *    cycle -- must not receive either. A convenience screen is the likeliest
 *    place for that to happen quietly.
 */

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

/** A program, an organization, an award with terms, and one report period. */
async function scenario(opts: { dueDate?: string } = {}) {
  const adminCtx = ctxFor(adminSession());
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `todo-${++seq}` });
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,'individuals_served','How many?','integer','people',1,10,'active',NULL,?,?)`,
    )
    .bind(newId(), p.programId, now, now)
    .run();
  const form = await buildReportForm(db, adminCtx, { programId: p.programId });
  await db
    .prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
    .bind(now, form.formDefinitionId)
    .run();

  const orgId = newId();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Bayou Harbor Trust ${seq}`, String(880000000 + seq), now, now)
    .run();

  const awardId = newId();
  await db
    .prepare(
      `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
         status, source_system, source_reference, term_start, term_end, created_at, updated_at)
       VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    )
    .bind(
      awardId, orgId, p.programId, 2_500_000, now, `TD-${awardId.slice(0, 8)}`,
      day('2025-01-01'), day('2025-12-31'), now, now,
    )
    .run();
  await generateReportPeriods(db, adminCtx, awardId);

  const period = await db
    .prepare(`SELECT id FROM report_periods WHERE award_id=?`)
    .bind(awardId)
    .first<{ id: string }>();
  if (opts.dueDate) {
    await forceDueDate(period!.id, opts.dueDate);
  }

  return { programId: p.programId, orgId, awardId, periodId: period!.id };
}

/** `n` days from now, as a date string the report tables use. */
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

/** A pending claim, written directly: the public route's own tests cover it. */
async function pendingClaim(name: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO grantee_claims
         (id, organization_name, ein, contact_first_name, contact_last_name, contact_email,
          contact_phone, contact_job_title, grant_year, grant_description, status,
          created_at, updated_at, submission_ip, submission_user_agent)
       VALUES (?,?,NULL,'Dana','Reyes',?,NULL,NULL,2025,NULL,'pending',?,?,'203.0.113.9','test')`,
    )
    .bind(id, name, `claim-${id.slice(0, 8)}@example.org`, now, now)
    .run();
  return id;
}

/**
 * A file with a destruction date inside the horizon.
 *
 * Written straight onto an attachment rather than driven through
 * recomputeDueDates: this test is about whether a due file reaches the screen
 * and who is allowed to see it, and retention.test.ts owns the question of
 * which files acquire a date in the first place.
 */
async function fileDueIn(orgId: string, days: number): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at, purge_due_at)
       VALUES (?, 'application', NULL, ?, ?, 'audited-2025.pdf', 'application/pdf', 9, ?, ?)`,
    )
    .bind(id, orgId, `orgs/${orgId}/${id}`, now, inDays(days))
    .run();
  return id;
}

describe('the to-do list', () => {
  it('is empty when nothing is outstanding, and says so by being empty', async () => {
    const admin = adminSession();
    // A report period a year out: it exists, it is open, and it is nobody's
    // work today. The horizon has to exclude it or "empty" never happens.
    const s = await scenario({ dueDate: inDays(300) });

    /*
     * NOT A FILTER ON ONE KIND. This asserted only that no `report_due` item
     * appeared, so a spurious item of any other kind passed -- on the one
     * test guarding the property the module leads with, that an empty list
     * means nothing is outstanding. Scoped to this scenario's own rows,
     * because the database is shared across tests in this file.
     */
    const out = await todo(db, admin, nowIso());
    const mine = out.items.filter((i) => i.id.endsWith(s.periodId) || i.id.endsWith(s.awardId));
    expect(mine).toEqual([]);
  });

  it('carries a report sent back for revisions, which the grantee still owes', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(-5) });
    await db
      .prepare(`UPDATE report_periods SET status = 'revisions_requested' WHERE id = ?`)
      .bind(s.periodId)
      .run();

    /*
     * THE GAP THIS CLOSES. The status test was spelled out here as `open` or
     * `scheduled`, which silently dropped revisions_requested -- a report the
     * Foundation sent back and is waiting on. reportDue.GRANTEE_OWES has
     * always included it, the compliance desk counted it overdue, and the
     * application gate could block that nonprofit's next cycle over it, while
     * this screen showed nothing.
     */
    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `overdue:${s.periodId}`);
    expect(row).toBeDefined();
    expect(row!.urgency).toBe('now');
    // And it is NOT described as unasked -- it has been asked for twice.
    expect(row!.detail).not.toContain('Nobody has asked');
  });

  it('surfaces an overdue report as needing attention now', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(-9) });

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `overdue:${s.periodId}`);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('report_overdue');
    expect(row!.urgency).toBe('now');
    // The detail says HOW overdue. "Overdue" alone does not tell anybody
    // whether to send a reminder or pick up the phone.
    expect(row!.detail).toContain('9 days ago');
    expect(row!.href).toContain(s.periodId);
  });

  it('surfaces a report due inside the horizon, but not one beyond it', async () => {
    const admin = adminSession();
    /*
     * THE HORIZON IS PINNED TO A NUMBER, not expressed in terms of itself.
     * Written as REPORT_HORIZON_DAYS ± n, changing the constant from 14 to
     * 3650 passed, so the value was unprotected by the test that names it.
     */
    expect(REPORT_HORIZON_DAYS).toBe(14);
    const near = await scenario({ dueDate: inDays(13) });
    const far = await scenario({ dueDate: inDays(44) });

    const out = await todo(db, admin, nowIso());
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain(`due:${near.periodId}`);
    expect(ids).not.toContain(`due:${far.periodId}`);

    /*
     * 'now', not 'soon', because the period is still 'scheduled' -- generated
     * from the award's terms and never requested. The outstanding act is the
     * Foundation's, and it has to happen BEFORE the date.
     */
    const row = out.items.find((i) => i.id === `due:${near.periodId}`)!;
    expect(row.urgency).toBe('now');
    expect(row.detail).toContain('Nobody has asked them for it yet');
  });

  it('calls a requested report due soon merely soon', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(REPORT_HORIZON_DAYS - 1) });
    // Asked for. The ball is now in the grantee's court, and the date is the
    // only thing left to watch.
    await db
      .prepare(`UPDATE report_periods SET status='open' WHERE id=?`)
      .bind(s.periodId)
      .run();

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `due:${s.periodId}`)!;
    expect(row.urgency).toBe('soon');
    expect(row.detail).not.toContain('Nobody has asked');
  });

  it('keeps an overdue report that nobody ever requested, and says so', async () => {
    const admin = adminSession();
    // The worst row the screen can carry: the report is late and the grantee
    // was never told it was coming. Before this file existed, nothing in the
    // system distinguished it from a nonprofit ignoring three reminders.
    const s = await scenario({ dueDate: inDays(-20) });

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `overdue:${s.periodId}`)!;
    expect(row.detail).toContain('Nobody has asked them for it yet');
  });

  it('counts a filed report as work for the Foundation, not for the grantee', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(20) });
    /*
     * Marked submitted directly rather than driven through the portal: this
     * test is about who the obligation belongs to once it is filed, and the
     * submission path has its own tests. A filed report is the one obligation
     * nothing else in the system chases -- no reminder goes to the Foundation.
     */
    await db
      .prepare(`UPDATE report_periods SET status='submitted' WHERE id=?`)
      .bind(s.periodId)
      .run();

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `filed:${s.periodId}`);
    expect(row).toBeDefined();
    expect(row!.urgency).toBe('now');
    // And it must NOT also appear as something due or overdue: one obligation,
    // one row, or the count at the top of the screen lies.
    expect(out.items.filter((i) => i.id.endsWith(s.periodId))).toHaveLength(1);
  });

  it('drops a report that has been answered', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(-40) });
    await db
      .prepare(`UPDATE report_periods SET status='accepted' WHERE id=?`)
      .bind(s.periodId)
      .run();

    const out = await todo(db, admin, nowIso());
    expect(out.items.filter((i) => i.id.endsWith(s.periodId))).toHaveLength(0);
  });

  it('lists a waiting claim, named, and always as now', async () => {
    const admin = adminSession();
    const id = await pendingClaim(`Third Ward Futures ${++seq}`);

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `claim:${id}`);
    expect(row).toBeDefined();
    expect(row!.urgency).toBe('now');
    expect(row!.title).toContain('Third Ward Futures');
    expect(row!.href).toBe('/past-grantees');
  });

  it('orders by urgency, then by what has waited longest', async () => {
    const admin = adminSession();
    const older = await scenario({ dueDate: inDays(-30) });
    const newer = await scenario({ dueDate: inDays(-2) });
    const soon = await scenario({ dueDate: inDays(3) });

    const out = await todo(db, admin, nowIso());
    const at = (id: string) => out.items.findIndex((i) => i.id.endsWith(id));
    expect(at(older.periodId)).toBeLessThan(at(newer.periodId));
    expect(at(newer.periodId)).toBeLessThan(at(soon.periodId));
  });

  it('does not hand a reviewer the admin-only claims queue', async () => {
    const reviewer = reviewerSession();
    const id = await pendingClaim(`Harrisburg Arts ${++seq}`);

    // An admin sees it...
    const forAdmin = await todo(db, adminSession(), nowIso());
    expect(forAdmin.items.map((i) => i.id)).toContain(`claim:${id}`);

    // ...and a reviewer gets a list, but not that row. /api/grantee-claims is
    // ADMIN_ONLY; this endpoint is STAFF_READ, and the difference has to be
    // made up inside the module or the screen widens the surface.
    const forReviewer = await todo(db, reviewer, nowIso());
    expect(forReviewer.items.some((i) => i.kind === 'claim')).toBe(false);
  });

  it('lists a file about to be destroyed', async () => {
    const admin = adminSession();
    const s = await scenario({ dueDate: inDays(300) });
    const fileId = await fileDueIn(s.orgId, 5);

    const out = await todo(db, admin, nowIso());
    const row = out.items.find((i) => i.id === `file:${fileId}`);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('files_due');
    expect(row!.detail).toContain('audited-2025.pdf');
    expect(row!.href).toBe('/retention');
  });

  it('does not hand a reviewer the retention schedule', async () => {
    const s = await scenario({ dueDate: inDays(300) });
    const fileId = await fileDueIn(s.orgId, 5);

    // The admin sees it, so the row genuinely exists -- without this half the
    // test would pass on an empty table and prove nothing.
    const forAdmin = await todo(db, adminSession(), nowIso());
    expect(forAdmin.items.map((i) => i.id)).toContain(`file:${fileId}`);

    const forReviewer = await todo(db, reviewerSession(), nowIso());
    expect(forReviewer.items.some((i) => i.kind === 'files_due')).toBe(false);
  });

  it('reports whether the list is the whole list, in both directions', async () => {
    const admin = adminSession();
    // Two obligations, so that asking for a page of one genuinely truncates.
    await scenario({ dueDate: inDays(-5) });
    await scenario({ dueDate: inDays(-6) });
    // True at this Foundation's volume for the next decade.
    expect((await todo(db, admin, nowIso())).complete).toBe(true);

    /*
     * AND THE OTHER DIRECTION, which is the informative one and was missing:
     * asserting only `true` on a near-empty database passes if the field is
     * hardcoded. Driven by shrinking the page rather than by inserting five
     * hundred rows, which is the same condition reportPortfolio reports.
     */
    const few = await todo(db, admin, nowIso(), 1);
    expect(few.complete).toBe(false);
  });

  it('refuses an applicant outright', async () => {
    const err = await appErrorFrom(todo(db, applicantSession(newId()), nowIso()));
    expect(err.code).toBe('FORBIDDEN');
  });

  it('refuses a grantee outright', async () => {
    const orgId = newId();
    const grantee = { userId: newId(), email: 'g@example.org', role: 'grantee' as const, organizationId: orgId };
    const err = await appErrorFrom(todo(db, grantee, nowIso()));
    expect(err.code).toBe('FORBIDDEN');
  });
});
