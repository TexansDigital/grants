/**
 * The public list of who was funded.
 *
 * WHY THIS EXISTS. Most funders publish this, it costs no extra data entry,
 * and it partly serves the external reporting that is manual today. CLAUDE.md
 * lists it as an optional module and it is cheap because every field on it is
 * already recorded for another reason.
 *
 * THE DANGEROUS PART IS NOT WHAT IT SHOWS, IT IS WHEN. An award published
 * before the grantee has been told, or before the coordinated announcement
 * date, is the exact reputational failure the decision-communication work was
 * shaped around -- and it would be worse here, because a web page is public to
 * everyone at once rather than to one mailbox. Three conditions therefore gate
 * every row, and all three are in SQL rather than in a caller:
 *
 *   1. An admin has marked the award public. Default is private; publishing
 *      another organization's grant is an opt-in, never a default. That is
 *      0012's own comment on the column, and this is the first code to honour
 *      it.
 *   2. The grantee has been told. `decision_communicated_at` on the
 *      application -- the same stamp that stops the applicant portal breaking
 *      the news.
 *   3. The embargo has passed. `announcement_date` is a separate fact from the
 *      decision for exactly this reason; an award with no announcement date
 *      has no embargo to wait for.
 *
 * WHAT IT NEVER CARRIES. No contact name or address, no EIN, no narrative, no
 * reviewer score, no internal note, no decision rationale. Those are not
 * filtered out of a wider query -- they are never selected. An organization
 * that applied for a grant did not consent to its application being published,
 * and the parts of this that are public are the parts a funder publishes: who,
 * for what, how much.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { nowIso } from './time';
import { auditStatement } from './audit';

export interface PublicGrant {
  organizationName: string;
  programName: string;
  fiscalYear: number | null;
  projectTitle: string | null;
  awardedAmountCents: number;
  /** The year the award was made, for grouping. Not the exact date. */
  awardedYear: string;
}

/**
 * Every award the Foundation has chosen to publish, newest first.
 *
 * NO PAGINATION, deliberately. This is 25 to 100 awards a year against a
 * handful of years; a page that shows all of them is one somebody can search
 * with their browser, and a paginated one is three clicks to discover that a
 * grant is not listed.
 *
 * CANCELLED AWARDS ARE EXCLUDED even when marked public. A grant that was
 * rescinded or refused is not one the Foundation made.
 */
export async function publicGrants(db: D1Database, nowIsoStr: string): Promise<PublicGrant[]> {
  const { results } = await db
    .prepare(
      `SELECT o.legal_name AS organizationName,
              p.name AS programName,
              p.fiscal_year AS fiscalYear,
              a.project_title AS projectTitle,
              w.awarded_amount_cents AS awardedAmountCents,
              substr(w.awarded_at, 1, 4) AS awardedYear
         FROM awards w
         JOIN organizations o ON o.id = w.organization_id
         JOIN programs p      ON p.id = w.program_id
         -- INNER JOIN, not LEFT. An award with no application is an imported
         -- historical record whose grantee this system never told anything,
         -- and it has no communication stamp to check. Publishing one would
         -- mean publishing on a condition that cannot be evaluated.
         JOIN applications a  ON a.id = w.application_id
        WHERE w.is_public = 1
          AND w.status <> 'cancelled'
          AND w.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND a.deleted_at IS NULL
          AND a.decision_communicated_at IS NOT NULL
          AND (w.announcement_date IS NULL OR w.announcement_date <= ?)
        ORDER BY w.awarded_at DESC, o.legal_name`,
    )
    .bind(nowIsoStr)
    .all<PublicGrant>();
  return results ?? [];
}

export interface PublishableAward {
  awardId: string;
  organizationName: string;
  projectTitle: string | null;
  awardedAmountCents: number;
  isPublic: boolean;
  /** Null when it is publishable; otherwise why it is not, in plain words. */
  blockedBecause: string | null;
}

/**
 * What an admin sees when deciding what to publish.
 *
 * IT LISTS AWARDS THAT CANNOT YET BE PUBLISHED, with the reason, rather than
 * hiding them. An admin who marks an award public and then cannot find it on
 * the page will assume the feature is broken; being told "the grantee has not
 * been told yet" is the difference between a rule and a bug.
 */
export async function publishableAwards(
  db: D1Database,
  session: Session,
  cycleId: string,
  nowIsoStr: string,
): Promise<PublishableAward[]> {
  if (session.role !== 'admin') throw notFound('cycle');
  const { results } = await db
    .prepare(
      `SELECT w.id AS awardId, o.legal_name AS organizationName,
              a.project_title AS projectTitle,
              w.awarded_amount_cents AS awardedAmountCents,
              w.is_public AS isPublic, w.status,
              w.announcement_date AS announcementDate,
              a.decision_communicated_at AS communicatedAt
         FROM awards w
         JOIN organizations o ON o.id = w.organization_id
         JOIN applications a  ON a.id = w.application_id AND a.deleted_at IS NULL
        WHERE a.cycle_id = ? AND w.deleted_at IS NULL
        ORDER BY o.legal_name`,
    )
    .bind(cycleId)
    .all<{
      awardId: string; organizationName: string; projectTitle: string | null;
      awardedAmountCents: number; isPublic: number; status: string;
      announcementDate: string | null; communicatedAt: string | null;
    }>();

  return (results ?? []).map((r) => ({
    awardId: r.awardId,
    organizationName: r.organizationName,
    projectTitle: r.projectTitle,
    awardedAmountCents: r.awardedAmountCents,
    isPublic: r.isPublic === 1,
    blockedBecause:
      r.status === 'cancelled'
        ? 'This award was cancelled.'
        : r.communicatedAt === null
          ? 'The grantee has not been told yet.'
          : r.announcementDate !== null && r.announcementDate > nowIsoStr
            ? `Embargoed until ${r.announcementDate.slice(0, 10)}.`
            : null,
  }));
}

/**
 * Mark one award public, or take it back.
 *
 * ADMIN ONLY, AND AUDITED BOTH WAYS. Publishing another organization's grant
 * is a decision about them, and un-publishing one is usually a decision about
 * a mistake; both are things somebody will later ask about.
 *
 * THE GATES ARE NOT CHECKED HERE, and that is deliberate. An admin may mark an
 * award public before the embargo lifts -- that is ordinary preparation for an
 * announcement, and `publicGrants` simply will not show it until the date
 * passes. Refusing the flag would force somebody to remember to come back on
 * the morning of the announcement, which is exactly the kind of thing that
 * gets forgotten.
 */
export async function setAwardPublic(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  isPublic: boolean,
): Promise<{ awardId: string; isPublic: boolean }> {
  if (session.role !== 'admin') throw notFound('award');

  const row = await db
    .prepare(
      `SELECT id, is_public AS isPublic, application_id AS applicationId
         FROM awards WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{ id: string; isPublic: number; applicationId: string | null }>();
  if (!row) throw notFound('award');

  if (isPublic && !row.applicationId) {
    /*
     * An imported historical award has no application, so there is no
     * communication stamp to check and publicGrants cannot evaluate its
     * condition. Refusing the flag with a reason beats setting it and having
     * the award silently never appear.
     */
    throw new AppError('CONFLICT', 'This award was imported and cannot be published here.', {
      internalMessage: `attempt to publish award ${awardId} with no application`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(`UPDATE awards SET is_public = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(isPublic ? 1 : 0, now, awardId),
    auditStatement(db, ctx, {
      action: 'award.amended',
      entityType: 'award',
      entityId: awardId,
      before: { is_public: row.isPublic },
      after: { is_public: isPublic ? 1 : 0, actor_user_id: session.userId },
    }),
  ]);

  return { awardId, isPublic };
}
