/**
 * One nonprofit, and everything the Foundation knows about them.
 *
 * WHY THIS IS NOT organizationHistoryForStaff. That function exists, it is
 * good, and it cannot answer this question -- because its first act is:
 *
 *     SELECT COUNT(*) FROM applications WHERE organization_id = ?
 *     ... if zero, notFound
 *
 * which is exactly right for its job (a reviewer must not learn that an
 * organization exists by probing ids) and exactly wrong for every nonprofit
 * the Foundation currently funds. Imported grants have no application, so all
 * thirteen 2025 Inspire Change grantees return 404 from that endpoint, to an
 * admin, today. It is the same shape of hole as the award page: a screen
 * gated on a record these organizations do not have.
 *
 * WHAT THIS PAGE IS FOR. CLAUDE.md asks for institutional memory -- "this org
 * has applied three times, was funded once for $25,000, filed both reports on
 * time" -- and says plainly that it currently lives in one person's head. This
 * assembles it: the grants, the applications, whether their reports came in,
 * and whether anybody there can actually log in.
 *
 * THAT LAST ONE IS THE OPERATIONAL QUESTION RIGHT NOW. Reminders only reach
 * grantees who already have an account. A nonprofit that has never claimed
 * their grant is invisible to every automated nudge in the system, and the
 * only way to know is to look. So this says it in a field rather than leaving
 * it to be inferred from an empty contact list.
 *
 * ADMIN ONLY. It carries award amounts, which CLAUDE.md puts outside a
 * reviewer's reach without qualification. Reviewers keep the history panel on
 * the application they are scoring, which is scoped to their own assignments
 * and shows counts rather than amounts.
 */

import type { Session } from '../types';
import { notFound } from './errors';
import { today } from './reportDue';

/** One grant, as much as a list row needs. */
export interface OrganizationAward {
  id: string;
  programName: string;
  awardedAmountCents: number;
  awardedAt: string;
  status: string;
  termStart: string | null;
  termEnd: string | null;
  /** Obligations on this grant, and how they have gone. */
  reportsTotal: number;
  reportsAccepted: number;
  reportsOverdue: number;
  reportsOutstanding: number;
}

export interface OrganizationApplication {
  id: string;
  status: string;
  submittedAt: string | null;
  requestedAmountCents: number | null;
  projectTitle: string | null;
  cycleName: string | null;
}

export interface OrganizationContact {
  name: string;
  email: string;
  jobTitle: string | null;
  isPrimary: boolean;
  /** True when a user row exists for this email on this organization. */
  hasAccount: boolean;
  /** Null when they have never completed a sign-in. */
  lastLoginAt: string | null;
}

export interface OrganizationOverview {
  id: string;
  legalName: string;
  ein: string | null;
  einVerifiedAt: string | null;
  website: string | null;
  mission: string | null;
  annualOperatingBudgetCents: number | null;
  status: string;
  /** Set when this record was merged into another. The page says so loudly. */
  mergedIntoId: string | null;
  mergedIntoName: string | null;

  awards: OrganizationAward[];
  applications: OrganizationApplication[];
  contacts: OrganizationContact[];

  /** Every grant ever made to them, in cents. Integer arithmetic throughout. */
  totalAwardedCents: number;
  /**
   * An account exists for somebody here.
   *
   * NOT evidence that anybody can be reached, and this field was briefly used
   * as though it were. The awards importer creates a `users` row for every
   * imported grant that carried a contact email, so all thirteen 2025
   * grantees "have an account" that a spreadsheet made for them: nobody
   * verified the address, nobody there knows the account exists, and nobody
   * has used it. A screen that read this as "can sign in" said Yes for every
   * one of them and made the question unanswerable.
   */
  hasAccount: boolean;
  /**
   * When somebody here last completed a sign-in, or null if nobody ever has.
   *
   * THIS is the honest signal. `users.last_login_at` is written only by
   * recordLogin, which runs when a magic link is actually redeemed -- so a
   * date here means a real person at this nonprofit opened a real email. Null
   * means every reminder this system has ever sent them is unaccounted for.
   */
  lastSignInAt: string | null;
}

export async function organizationOverview(
  db: D1Database,
  session: Session,
  organizationId: string,
): Promise<OrganizationOverview> {
  if (session.role !== 'admin') throw notFound('organization');

  const org = await db
    .prepare(
      `SELECT o.id, o.legal_name AS legalName, o.ein, o.ein_verified_at AS einVerifiedAt,
              o.website, o.mission,
              o.annual_operating_budget_cents AS annualOperatingBudgetCents,
              o.status, o.merged_into_id AS mergedIntoId,
              m.legal_name AS mergedIntoName
         FROM organizations o
         LEFT JOIN organizations m ON m.id = o.merged_into_id
        WHERE o.id = ? AND o.deleted_at IS NULL`,
    )
    .bind(organizationId)
    .first<Record<string, unknown>>();
  if (!org) throw notFound('organization');

  const [awards, applications, contacts] = await Promise.all([
    /*
     * The report counts are computed in SQL alongside the award rather than
     * by fetching every period and counting in JavaScript. One organization
     * has a handful of grants, so either would work -- but the counts are the
     * point of the row, and a correlated subquery keeps "a grant and how its
     * reporting went" as a single thing that cannot come apart.
     *
     * 'overdue' here compares against reportDue's own calendar day, so it
     * cannot diverge from the compliance desk. It bound a full ISO instant,
     * which is a DIFFERENT predicate -- a due date stored as a plain date or
     * as midnight UTC sorts before any same-day timestamp, so a report due
     * today was counted as overdue here and called fine there, on two screens
     * one click apart. The bind is the fix; the substr beside it is defence
     * against a third storage shape and changes no result today.
     */
    db
      .prepare(
        `SELECT w.id, w.awarded_amount_cents AS awardedAmountCents,
                w.awarded_at AS awardedAt, w.status,
                w.term_start AS termStart, w.term_end AS termEnd,
                p.name AS programName,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL) AS reportsTotal,
                /*
                 * WAIVED COUNTS AS SETTLED, as it does on the dashboard. A
                 * grant with one accepted and one waived period has nothing
                 * outstanding, and reading "1 of 2 accepted" on a row where
                 * nothing is outstanding reads as a missing report.
                 */
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND rp.status IN ('accepted','waived')) AS reportsAccepted,
                /*
                 * CANCELLED AWARDS EXCLUDED, as dashboard.ts has done since
                 * it was written. When a grantee refuses an award, 0020
                 * records it as 'cancelled' and leaves any already-generated
                 * report periods alone -- so counted, they sit in the overdue
                 * column forever for a grant nobody ever took, with no way to
                 * clear them short of waiving a period on a cancelled award.
                 */
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND w.status <> 'cancelled'
                    AND rp.status IN ('scheduled','open','revisions_requested')
                    AND substr(rp.due_date, 1, 10) < ?) AS reportsOverdue,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND w.status <> 'cancelled'
                    AND rp.status IN ('scheduled','open','submitted',
                                      'revisions_requested')) AS reportsOutstanding
           FROM awards w
           JOIN programs p ON p.id = w.program_id
          WHERE w.organization_id = ? AND w.deleted_at IS NULL
          ORDER BY w.awarded_at DESC`,
      )
      .bind(today(new Date().toISOString()), organizationId)
      .all<OrganizationAward>(),

    db
      .prepare(
        `SELECT a.id, a.status, a.submitted_at AS submittedAt,
                a.requested_amount_cents AS requestedAmountCents,
                a.project_title AS projectTitle, c.name AS cycleName
           FROM applications a
           LEFT JOIN cycles c ON c.id = a.cycle_id
          WHERE a.organization_id = ? AND a.deleted_at IS NULL
          ORDER BY a.submitted_at DESC, a.created_at DESC`,
      )
      .bind(organizationId)
      .all<OrganizationApplication>(),

    /*
     * Contacts joined to users ON EMAIL, not on a foreign key, because there
     * is no column linking them: a contact is captured on an application, and
     * a user is created when a claim is approved or a magic link is first
     * requested. The two meet at the address, which is what the sign-in flow
     * itself keys on.
     *
     * NOT lower-cased on either side, though the first draft was. Both
     * `contacts.email` and `users.email` carry CHECK (email = lower(email))
     * from 0002, so a mixed-case row cannot exist and LOWER() here would
     * defend against nothing while preventing the index on users.email from
     * being used. The constraint is the guarantee; test/organizationPage
     * pins it so this stays true. If it is ever relaxed, this join needs
     * LOWER() back.
     */
    db
      .prepare(
        `SELECT TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS name,
                c.email, c.job_title AS jobTitle, c.is_primary AS isPrimary,
                u.id AS userId, u.last_login_at AS lastLoginAt
           FROM contacts c
           LEFT JOIN users u
                  ON u.email = c.email
                 AND u.organization_id = c.organization_id
                 AND u.is_active = 1
                 AND u.deleted_at IS NULL
          WHERE c.organization_id = ? AND c.deleted_at IS NULL
          ORDER BY c.is_primary DESC, c.last_name, c.first_name`,
      )
      .bind(organizationId)
      .all<Record<string, unknown>>(),
  ]);

  const contactRows: OrganizationContact[] = (contacts.results ?? []).map((c) => ({
    // A contact with neither name is not nothing -- the email identifies them,
    // and an empty cell under a "Name" heading reads as a broken row.
    name: String(c.name ?? '').trim() === '' ? String(c.email) : String(c.name),
    email: String(c.email),
    jobTitle: (c.jobTitle as string | null) ?? null,
    isPrimary: c.isPrimary === 1,
    hasAccount: c.userId != null,
    lastLoginAt: (c.lastLoginAt as string | null) ?? null,
  }));

  /*
   * Asked of USERS, not of contacts.
   *
   * An approved past-grantee claim creates a user without necessarily
   * creating a contact row, so deriving this from `contactRows` would report
   * "nobody has an account" for an organization that had just been connected
   * -- the precise moment somebody is checking.
   *
   * MAX over last_login_at rather than a count of non-null ones: the question
   * is whether ANYBODY here has ever got in, and when. SQLite's MAX ignores
   * NULLs, so an organization where one of three contacts has signed in
   * returns that date rather than null.
   */
  const signIn = await db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(last_login_at) AS lastSignInAt FROM users
        WHERE organization_id = ? AND is_active = 1 AND deleted_at IS NULL
          AND role IN ('applicant','grantee')`,
    )
    .bind(organizationId)
    .first<{ n: number; lastSignInAt: string | null }>();

  const awardRows = awards.results ?? [];

  return {
    id: org.id as string,
    legalName: org.legalName as string,
    ein: (org.ein as string | null) ?? null,
    einVerifiedAt: (org.einVerifiedAt as string | null) ?? null,
    website: (org.website as string | null) ?? null,
    mission: (org.mission as string | null) ?? null,
    annualOperatingBudgetCents: (org.annualOperatingBudgetCents as number | null) ?? null,
    status: org.status as string,
    mergedIntoId: (org.mergedIntoId as string | null) ?? null,
    mergedIntoName: (org.mergedIntoName as string | null) ?? null,
    awards: awardRows,
    applications: applications.results ?? [],
    contacts: contactRows,
    /*
     * Integer cents, summed as integers. No float ever touches this.
     *
     * CANCELLED AWARDS ARE EXCLUDED FROM THE TOTAL but still listed in
     * `awards` above, which is deliberate: the grant is part of the record
     * and the row carries its status, while the money is not committed. This
     * matches dashboard.ts, so the organization page and the dashboard cannot
     * report different totals for the same nonprofit.
     */
    totalAwardedCents: awardRows
      .filter((a) => a.status !== 'cancelled')
      .reduce((sum, a) => sum + a.awardedAmountCents, 0),
    hasAccount: (signIn?.n ?? 0) > 0,
    lastSignInAt: signIn?.lastSignInAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Every nonprofit the Foundation has a record of.
 *
 * THE COLUMN THAT MATTERS IS WHETHER ANYBODY HAS EVER SIGNED IN, and the
 * first version of it was wrong in a way worth recording. It asked whether a
 * `users` row existed and called that "can sign in" -- but the awards
 * importer creates one for every imported grant that carried a contact email,
 * so all thirteen 2025 grantees answered Yes to a question nobody had
 * actually put to them. The filter built on it returned nothing, and the one
 * thing this screen exists to find became unfindable.
 *
 * `last_login_at` is the honest signal. It is written only when a magic link
 * is redeemed, so a date means a real person at that nonprofit opened a real
 * email; null means every reminder we have ever sent them is unaccounted for.
 * That is the list somebody needs before a press goes out, and the detail
 * page can only answer it one nonprofit at a time.
 */
export interface OrganizationListRow {
  id: string;
  legalName: string;
  ein: string | null;
  einVerifiedAt: string | null;
  status: string;
  grants: number;
  totalAwardedCents: number;
  lastAwardedAt: string | null;
  applications: number;
  reportsOverdue: number;
  /** An account exists. Says nothing about whether anybody has used it. */
  hasAccount: boolean;
  /** When anybody here last completed a sign-in. Null if nobody ever has. */
  lastSignInAt: string | null;
}

export interface OrganizationListFilters {
  /** Legal name or EIN. */
  q?: string | null;
  /** Only nonprofits that have been funded. */
  fundedOnly?: boolean;
  /** Only funded nonprofits where nobody has ever signed in. */
  neverSignedInOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listOrganizations(
  db: D1Database,
  session: Session,
  filters: OrganizationListFilters = {},
): Promise<{ rows: OrganizationListRow[]; total: number }> {
  // Carries award totals, so admin only -- the same boundary as the detail.
  if (session.role !== 'admin') throw notFound('organizations');

  const where: string[] = ['o.deleted_at IS NULL'];
  const binds: unknown[] = [];

  const q = (filters.q ?? '').trim();
  if (q !== '') {
    const digits = q.replace(/\D/g, '');
    where.push(`(LOWER(o.legal_name) LIKE ? OR (? <> '' AND o.ein = ?))`);
    binds.push(`%${q.toLowerCase()}%`, digits, digits);
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const todayDate = today(new Date().toISOString());

  /*
   * Correlated subqueries rather than GROUP BY across three joins. Joining
   * awards, applications and report_periods to one organization row and then
   * grouping multiplies the rows against each other, which is how a nonprofit
   * with two grants and three applications acquires six grants -- a wrong
   * number on a money column, arrived at silently. Subqueries each count
   * their own thing and cannot interfere.
   */
  const sql = `
    SELECT o.id, o.legal_name AS legalName, o.ein,
           o.ein_verified_at AS einVerifiedAt, o.status,
           (SELECT COUNT(*) FROM awards w
             WHERE w.organization_id = o.id AND w.deleted_at IS NULL) AS grants,
           /*
            * CANCELLED EXCLUDED, matching dashboard.ts's definition of
            * committed money. A refused or rescinded award is money the
            * Foundation promised and did not give; counting it made this
            * column disagree with the dashboard for the same organization --
            * $65,000 here against $25,000 there, with nothing saying why.
            * A pending offer is kept, as the dashboard keeps it: an offer
            * out and not yet refused is still committed.
            */
           (SELECT COALESCE(SUM(w.awarded_amount_cents), 0) FROM awards w
             WHERE w.organization_id = o.id AND w.deleted_at IS NULL
               AND w.status <> 'cancelled')
             AS totalAwardedCents,
           (SELECT MAX(w.awarded_at) FROM awards w
             WHERE w.organization_id = o.id AND w.deleted_at IS NULL) AS lastAwardedAt,
           (SELECT COUNT(*) FROM applications a
             WHERE a.organization_id = o.id AND a.deleted_at IS NULL) AS applications,
           (SELECT COUNT(*) FROM report_periods rp
              JOIN awards w2 ON w2.id = rp.award_id
             WHERE w2.organization_id = o.id AND w2.deleted_at IS NULL
               AND w2.status <> 'cancelled'
               AND rp.deleted_at IS NULL
               AND rp.status IN ('scheduled','open','revisions_requested')
               AND substr(rp.due_date, 1, 10) < ?) AS reportsOverdue,
           (SELECT COUNT(*) FROM users u
             WHERE u.organization_id = o.id AND u.is_active = 1 AND u.deleted_at IS NULL
               AND u.role IN ('applicant','grantee')) AS accounts,
           /*
            * MAX ignores NULLs in SQLite, so this is the most recent sign-in
            * by ANYBODY here, and null only when not one of them has ever
            * got in. A count of non-null logins would have answered a
            * different and less useful question.
            */
           (SELECT MAX(u.last_login_at) FROM users u
             WHERE u.organization_id = o.id AND u.is_active = 1 AND u.deleted_at IS NULL
               AND u.role IN ('applicant','grantee')) AS lastSignInAt
      FROM organizations o
     WHERE ${where.join(' AND ')}
     ORDER BY o.legal_name`;

  const { results } = await db
    .prepare(`${sql} LIMIT ? OFFSET ?`)
    .bind(todayDate, ...binds, limit, offset)
    .all<Record<string, unknown>>();

  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM organizations o WHERE ${where.join(' AND ')}`)
    .bind(...binds)
    .first<{ n: number }>();

  let rows: OrganizationListRow[] = (results ?? []).map((r) => ({
    id: r.id as string,
    legalName: r.legalName as string,
    ein: (r.ein as string | null) ?? null,
    einVerifiedAt: (r.einVerifiedAt as string | null) ?? null,
    status: r.status as string,
    grants: r.grants as number,
    totalAwardedCents: r.totalAwardedCents as number,
    lastAwardedAt: (r.lastAwardedAt as string | null) ?? null,
    applications: r.applications as number,
    reportsOverdue: r.reportsOverdue as number,
    hasAccount: (r.accounts as number) > 0,
    lastSignInAt: (r.lastSignInAt as string | null) ?? null,
  }));

  // Both filters run after the page, so `total` is the unfiltered count --
  // named separately rather than conflated, as the compliance desk does.
  if (filters.fundedOnly) rows = rows.filter((r) => r.grants > 0);
  /*
   * FUNDED, and nobody has ever signed in. The funded half matters: an
   * organization that has only ever applied and never signed in is not a
   * problem, while a grantee who has not is one nobody will otherwise notice.
   */
  if (filters.neverSignedInOnly) {
    rows = rows.filter((r) => r.grants > 0 && r.lastSignInAt === null);
  }

  return { rows, total: counted?.n ?? rows.length };
}
