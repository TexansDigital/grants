/**
 * One grant, on one page.
 *
 * WHY THIS EXISTS, AND IT IS NOT A CONVENIENCE. Everything the system knows
 * about an award -- its paperwork, its payments, its amendments, its report
 * obligations -- was rendered inside DecisionPanel, which is mounted inside
 * ApplicationDetail, which is reachable only at /applications/:id.
 *
 * Imported awards have no application. `importAwards` writes them with
 * `application_id = NULL`, because a grant made in 2025 through a Formstack
 * form that has since been retired has no application in this system and
 * inventing one would be recording a fiction. The consequence was that the
 * thirteen 2025 Inspire Change grants -- the entire reason this platform is
 * being launched -- had no page at all. Their W-9 status, their payments,
 * their amendment history and their report periods existed in the database,
 * were served by working endpoints, and could not be looked at by anybody.
 *
 * So this is the award's own page, and the application is a LINK FROM it
 * rather than the thing that contains it. That is also the right model for
 * awards that do have one: an award can be amended, renewed and reported on
 * for years after the application that earned it stopped being the
 * interesting document, and a renewal has no application of its own at all.
 *
 * WHAT IT COMPOSES, AND WHAT IT OWNS. The report obligations come from
 * reportPortfolio with an award filter, not from SQL written here: the
 * compliance desk and this page must never disagree about what is overdue.
 * The paperwork, payments and amendments each already have their own endpoint
 * and keep them. What this file owns is the award's own facts and its place in
 * a family -- the parent it renews, and the renewals made from it -- because
 * nothing else assembled those.
 */

import type { Session } from '../types';
import { notFound } from './errors';
import { reportPortfolio, type PortfolioRow } from './reportAdmin';

/** A linked award, named as little as the page needs to offer the link. */
export interface RelatedAward {
  id: string;
  awardedAmountCents: number;
  awardedAt: string;
  status: string;
  termStart: string | null;
  termEnd: string | null;
}

export interface AwardOverview {
  awardId: string;
  organizationId: string;
  organizationName: string;
  programId: string;
  programName: string;
  cycleId: string | null;
  cycleName: string | null;
  /*
   * Null for every imported grant and every renewal. The page must read well
   * with it absent -- that is the normal state for the thirteen, not an edge
   * case -- so nothing here is phrased as though an application exists.
   */
  applicationId: string | null;
  projectTitle: string | null;
  awardedAmountCents: number;
  awardedAt: string;
  announcementDate: string | null;
  termStart: string | null;
  termEnd: string | null;
  status: string;
  isMultiYear: boolean;
  isPublic: boolean;
  /** 'formstack' | 'spreadsheet' | 'manual', or null for one made in-app. */
  sourceSystem: string | null;
  sourceReference: string | null;
  acceptedAt: string | null;
  declinedByGranteeAt: string | null;
  /** The award this one renews, if any. */
  parent: RelatedAward | null;
  /** Awards made from this one. Renewals, never duplicated records. */
  renewals: RelatedAward[];
  /** This award's obligations, from the same query the compliance desk uses. */
  reports: PortfolioRow[];
  /*
   * WHY NO REPORT PERIODS EXIST, when none do. An empty list is ambiguous
   * between "this grant owes nothing" and "nobody has asked", and for the
   * thirteen imported grants it is always the second. Said in words, because
   * an admin looking at a blank section should not have to know that
   * generation requires term dates.
   */
  whyNoReports: 'has_reports' | 'no_term_dates' | 'not_requested';
}

const RELATED = `id, awarded_amount_cents AS awardedAmountCents, awarded_at AS awardedAt,
                 status, term_start AS termStart, term_end AS termEnd`;

export async function awardOverview(
  db: D1Database,
  session: Session,
  awardId: string,
): Promise<AwardOverview> {
  /*
   * ADMIN ONLY, and a 404 rather than a 403. This page carries an
   * organization's grant history, its paperwork status and its payment
   * schedule; the paperwork and payment endpoints it sits beside are both
   * admin-only, and a page that assembled them for a reviewer would widen
   * three surfaces at once. notFound, not forbidden, so that changing an id
   * in the address bar tells a reviewer nothing about which awards exist.
   */
  if (session.role !== 'admin') throw notFound('award');

  const row = await db
    .prepare(
      `SELECT w.id, w.organization_id AS organizationId, w.program_id AS programId,
              w.cycle_id AS cycleId, w.application_id AS applicationId,
              w.awarded_amount_cents AS awardedAmountCents, w.awarded_at AS awardedAt,
              w.announcement_date AS announcementDate,
              w.term_start AS termStart, w.term_end AS termEnd, w.status,
              w.is_multi_year AS isMultiYear, w.parent_award_id AS parentAwardId,
              w.is_public AS isPublic, w.source_system AS sourceSystem,
              w.source_reference AS sourceReference,
              w.accepted_at AS acceptedAt, w.declined_by_grantee_at AS declinedByGranteeAt,
              o.legal_name AS organizationName,
              p.name AS programName,
              c.name AS cycleName,
              app.project_title AS projectTitle
         FROM awards w
         JOIN organizations o ON o.id = w.organization_id
         JOIN programs p ON p.id = w.program_id
         LEFT JOIN cycles c ON c.id = w.cycle_id
         -- LEFT, and the deleted_at check is on the join rather than the
         -- WHERE: an award whose application was soft-deleted still has to
         -- render, with no link, instead of vanishing from the system.
         LEFT JOIN applications app ON app.id = w.application_id AND app.deleted_at IS NULL
        WHERE w.id = ? AND w.deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<Record<string, unknown>>();

  if (!row) throw notFound('award');

  const [parent, renewals, reports] = await Promise.all([
    row.parentAwardId == null
      ? Promise.resolve(null)
      : db
          .prepare(`SELECT ${RELATED} FROM awards WHERE id = ? AND deleted_at IS NULL`)
          .bind(row.parentAwardId)
          .first<RelatedAward>(),
    db
      .prepare(
        `SELECT ${RELATED} FROM awards
          WHERE parent_award_id = ? AND deleted_at IS NULL
          ORDER BY awarded_at`,
      )
      .bind(awardId)
      .all<RelatedAward>(),
    reportPortfolio(db, session, { awardId, limit: 100 }),
  ]);

  const termStart = (row.termStart as string | null) ?? null;
  const termEnd = (row.termEnd as string | null) ?? null;

  return {
    awardId: row.id as string,
    organizationId: row.organizationId as string,
    organizationName: row.organizationName as string,
    programId: row.programId as string,
    programName: row.programName as string,
    cycleId: (row.cycleId as string | null) ?? null,
    cycleName: (row.cycleName as string | null) ?? null,
    applicationId: (row.applicationId as string | null) ?? null,
    projectTitle: (row.projectTitle as string | null) ?? null,
    awardedAmountCents: row.awardedAmountCents as number,
    awardedAt: row.awardedAt as string,
    announcementDate: (row.announcementDate as string | null) ?? null,
    termStart,
    termEnd,
    status: row.status as string,
    /*
     * SQLite has no booleans. The column is NOT NULL and CHECK-constrained to
     * 0 or 1, so `=== 1` and `Boolean(...)` cannot differ on any value the
     * database can hold -- this is not load-bearing today, and a mutation test
     * that swapped one for the other passed, correctly. `=== 1` is kept
     * because it is also right if a driver ever hands back the string "0",
     * which `Boolean` reads as true.
     */
    isMultiYear: row.isMultiYear === 1,
    isPublic: row.isPublic === 1,
    sourceSystem: (row.sourceSystem as string | null) ?? null,
    sourceReference: (row.sourceReference as string | null) ?? null,
    acceptedAt: (row.acceptedAt as string | null) ?? null,
    declinedByGranteeAt: (row.declinedByGranteeAt as string | null) ?? null,
    parent: parent ?? null,
    renewals: renewals.results ?? [],
    reports: reports.rows,
    /*
     * The two reasons are not interchangeable, and the fix differs. Without
     * term dates, generation cannot run at all and the next step is to amend
     * the award. With them, generation simply has not been asked for, and the
     * next step is the update request. Telling the two apart on the screen is
     * the whole point of saying anything.
     */
    whyNoReports:
      reports.rows.length > 0
        ? 'has_reports'
        : termStart === null || termEnd === null
          ? 'no_term_dates'
          : 'not_requested',
  };
}
