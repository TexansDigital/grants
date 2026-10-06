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
  /*
   * CAN ANYBODY HERE LOG IN? False means no automated reminder can ever reach
   * this organization, whatever is overdue -- somebody has to write to them.
   * It is the first thing to know about a grantee and the last thing anyone
   * would think to check.
   */
  canSignIn: boolean;
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
     * 'overdue' here is a date comparison, not reportDue.ts's definition.
     * That is deliberate and narrow: this is a COUNT for a summary row, and
     * the authoritative per-report view is the compliance desk, which the
     * page links to. It is not a second answer to "is this report late" for
     * anything to act on.
     */
    db
      .prepare(
        `SELECT w.id, w.awarded_amount_cents AS awardedAmountCents,
                w.awarded_at AS awardedAt, w.status,
                w.term_start AS termStart, w.term_end AS termEnd,
                p.name AS programName,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL) AS reportsTotal,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND rp.status = 'accepted') AS reportsAccepted,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND rp.status IN ('scheduled','open','revisions_requested')
                    AND rp.due_date < ?) AS reportsOverdue,
                (SELECT COUNT(*) FROM report_periods rp
                  WHERE rp.award_id = w.id AND rp.deleted_at IS NULL
                    AND rp.status IN ('scheduled','open','submitted',
                                      'revisions_requested')) AS reportsOutstanding
           FROM awards w
           JOIN programs p ON p.id = w.program_id
          WHERE w.organization_id = ? AND w.deleted_at IS NULL
          ORDER BY w.awarded_at DESC`,
      )
      .bind(new Date().toISOString(), organizationId)
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
   * The sign-in question is asked of USERS, not of contacts.
   *
   * An approved past-grantee claim creates a user without necessarily
   * creating a contact row, so deriving this from `contactRows` would report
   * "nobody can sign in" for an organization that had just been connected --
   * the precise moment somebody is checking.
   */
  const signIn = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE organization_id = ? AND is_active = 1 AND deleted_at IS NULL
          AND role IN ('applicant','grantee')`,
    )
    .bind(organizationId)
    .first<{ n: number }>();

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
    // Integer cents, summed as integers. No float ever touches this.
    totalAwardedCents: awardRows.reduce((sum, a) => sum + a.awardedAmountCents, 0),
    canSignIn: (signIn?.n ?? 0) > 0,
  };
}
