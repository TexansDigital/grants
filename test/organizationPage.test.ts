import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { organizationOverview } from '../src/lib/organizationPage';
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

  it('says plainly whether anybody there can sign in', async () => {
    const admin = adminSession();
    const programId = await program();
    const orgId = await org('Harrisburg Arts');
    await award({ programId, orgId });

    /*
     * THE OPERATIONAL QUESTION. Reminders only reach grantees who already
     * have an account, so an organization with no user is invisible to every
     * automated nudge in the system whatever is overdue.
     */
    expect((await organizationOverview(db, admin, orgId)).canSignIn).toBe(false);

    await granteeUser(orgId, `dana-${seq}@example.org`);
    expect((await organizationOverview(db, admin, orgId)).canSignIn).toBe(true);
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
    await db
      .prepare(`UPDATE report_periods SET due_date = ? WHERE award_id = ?`)
      .bind(day('2024-01-01'), awardId)
      .run();

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
    const programId = await program();
    const orgId = await org('Tidy');
    const keep = await award({ programId, orgId, cents: 1_000_000 });
    const gone = await award({ programId, orgId, cents: 9_900_000 });
    await db.prepare(`UPDATE awards SET deleted_at = ? WHERE id = ?`).bind(nowIso(), gone).run();

    const out = await organizationOverview(db, admin, orgId);
    expect(out.awards.map((a) => a.id)).toEqual([keep]);
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
