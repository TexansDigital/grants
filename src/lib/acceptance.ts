/**
 * A grantee accepting, or refusing, an award.
 *
 * THE DEAD END THIS ENDS. `awards.status` has admitted 'active' -- "accepted,
 * term running, reports expected" -- since 0012 and nothing could put an award
 * into it. `award.accepted` has been a declared audit action since Phase 0 and
 * nothing has ever written it. Data health checks active awards for a missing
 * W-9, agreement and media release, and those checks could never fire, because
 * no award could become active.
 *
 * Most visibly: the award letter tells a grantee to sign in and see "what we
 * need from you before funds are released". They sign in and there is nothing
 * to do.
 *
 * WHY ACCEPTANCE IS THE GRANTEE'S ACT AND NOT AN ADMIN'S. CLAUDE.md puts the
 * W-9 and the media release at acceptance rather than application, which only
 * means anything if acceptance is a moment the grantee causes. An admin
 * flipping a status is not that moment, and an award marked accepted by staff
 * is a claim about somebody else's decision.
 *
 * WHY A GRANTEE MAY SAY NO, and why it is recorded rather than deleted. Terms
 * do not always work. A project loses its other funding. An organization
 * folds between the decision and the letter. Without a refusal path those
 * awards sit `pending` forever, the committed total stays wrong, and the
 * portfolio cannot say what happened.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { sessionOrgId } from './scope';
import { generateReportPeriods } from './reportPeriods';

export interface PendingAward {
  id: string;
  programName: string;
  awardedAmountCents: number;
  awardedAt: string;
  announcementDate: string | null;
  termStart: string | null;
  termEnd: string | null;
  projectTitle: string | null;
}

/**
 * Awards this organization has been offered and not yet answered.
 *
 * SCOPED BY THE SESSION, never by a parameter. The organization comes from the
 * magic-link session; an award belonging to anybody else is not filtered out
 * of a larger set, it is never selected.
 */
export async function awardsAwaitingResponse(
  db: D1Database,
  session: Session,
): Promise<PendingAward[]> {
  const organizationId = sessionOrgId(session);
  const { results } = await db
    .prepare(
      `SELECT w.id, p.name AS programName, w.awarded_amount_cents AS awardedAmountCents,
              w.awarded_at AS awardedAt, w.announcement_date AS announcementDate,
              w.term_start AS termStart, w.term_end AS termEnd,
              a.project_title AS projectTitle
         FROM awards w
         JOIN programs p ON p.id = w.program_id
         LEFT JOIN applications a ON a.id = w.application_id
        WHERE w.organization_id = ?
          AND w.status = 'pending'
          AND w.accepted_at IS NULL
          AND w.declined_by_grantee_at IS NULL
          AND w.deleted_at IS NULL
        ORDER BY w.awarded_at DESC`,
    )
    .bind(organizationId)
    .all<PendingAward>();
  return results ?? [];
}

async function loadOwnPendingAward(
  db: D1Database,
  session: Session,
  awardId: string,
): Promise<{ id: string; organizationId: string; status: string; acceptedAt: string | null }> {
  const organizationId = sessionOrgId(session);
  const row = await db
    .prepare(
      `SELECT id, organization_id AS organizationId, status, accepted_at AS acceptedAt
         FROM awards
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(awardId, organizationId)
    .first<{ id: string; organizationId: string; status: string; acceptedAt: string | null }>();
  // 404 for another organization's award, exactly as for one that does not
  // exist. A 403 would confirm it is real.
  if (!row) throw notFound('award');
  return row;
}

export interface AcceptResult {
  awardId: string;
  acceptedAt: string;
  /** Report periods generated from the term, or 0 with a reason. */
  reportPeriodsCreated: number;
  reportPeriodsSkipped: string | null;
}

/**
 * Accept it.
 *
 * THE ATTESTATION IS REQUIRED and is not decoration. A grantee is agreeing to
 * a term, a reporting obligation and a set of documents; a button with no
 * statement beside it produces an acceptance nobody can characterise later.
 * The text the grantee saw is recorded on the audit row, so "what did they
 * agree to" survives a later change to the wording.
 *
 * REPORT PERIODS ARE GENERATED HERE. 'active' means "reports expected", and an
 * active award with no periods is a grantee who will be told they are overdue
 * for something that was never scheduled. Generation is best-effort: an award
 * with no term dates generates nothing and says so rather than inventing a
 * deadline a grantee is then held to.
 *
 * A FAILURE TO GENERATE DOES NOT UNDO THE ACCEPTANCE. The acceptance is the
 * grantee's act and is theirs; the schedule is the Foundation's bookkeeping.
 * Rolling back somebody's "yes" because our own scheduler had a bad day would
 * be the wrong half to sacrifice, and admins can generate periods later from
 * the reporting desk.
 */
export async function acceptAward(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  opts: { attestationText: string; note?: string | null },
): Promise<AcceptResult> {
  const attestation = (opts.attestationText ?? '').trim();
  if (!attestation) {
    throw new AppError('VALIDATION_FAILED', 'Please confirm the statement before accepting.', {
      internalMessage: 'acceptAward with no attestation',
      severity: 'warn',
      fieldErrors: [{ field: 'attested', message: 'Tick the box to accept this grant.' }],
    });
  }

  const award = await loadOwnPendingAward(db, session, awardId);
  if (award.acceptedAt) {
    throw new AppError('CONFLICT', 'You have already accepted this grant.', {
      internalMessage: `re-acceptance of ${awardId}, accepted at ${award.acceptedAt}`,
      severity: 'warn',
    });
  }
  if (award.status !== 'pending') {
    throw new AppError('CONFLICT', 'This grant is no longer waiting on you.', {
      internalMessage: `acceptAward on ${awardId} in status ${award.status}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  const note = (opts.note ?? '')?.toString().trim() || null;
  /*
   * GUARDED BOTH WAYS, because a double-click is the normal case here: a
   * grantee on a phone taps Accept twice. The UPDATE already refused the
   * second, but the audit INSERT did not, and the report periods below were
   * generated by both calls -- so the grantee ended with two final reports and
   * two `award.accepted` rows, and both requests returned 200. Reproduced by
   * an adversarial review.
   */
  const [write] = await db.batch([
    db
      .prepare(
        `UPDATE awards
            SET status = 'active', accepted_at = ?, accepted_by_user_id = ?,
                grantee_response_note = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND accepted_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, session.userId, note, now, awardId),
    auditStatement(db, ctx, {
      action: 'award.accepted',
      entityType: 'award',
      entityId: awardId,
      before: { status: 'pending', accepted_at: null },
      after: {
        status: 'active',
        accepted_at: now,
        accepted_by_user_id: session.userId,
        organization_id: award.organizationId,
        // The exact words the grantee saw. Recorded so "what did they agree
        // to" survives a later change to the wording.
        attestation,
        note,
      },
    }, {
      guard: {
        sql: `EXISTS (SELECT 1 FROM awards
                       WHERE id = ? AND accepted_at = ? AND accepted_by_user_id = ?)`,
        binds: [awardId, now, session.userId],
      },
    }),
  ]);

  if ((write?.meta?.changes ?? 0) === 0) {
    // The other click won. Saying so beats generating a second set of report
    // periods and returning a second acceptance time.
    throw new AppError('CONFLICT', 'You have already accepted this grant.', {
      internalMessage: `acceptAward lost a race on ${awardId}`,
      severity: 'warn',
    });
  }

  let created = 0;
  let skipped: string | null = null;
  try {
    const result = await generateReportPeriods(db, ctx, awardId);
    created = result.created;
    skipped = result.skipped ?? null;
  } catch {
    // Deliberately swallowed: see the note above. The acceptance stands and
    // the reporting desk can generate periods later.
    skipped = 'could not be generated now';
  }

  return { awardId, acceptedAt: now, reportPeriodsCreated: created, reportPeriodsSkipped: skipped };
}

/**
 * Refuse it, with a reason.
 *
 * The award becomes `cancelled`, which the dashboard already excludes from
 * committed totals -- so the money goes back to the program's uncommitted
 * balance the moment the grantee says no, rather than when somebody remembers
 * to tidy up.
 */
export async function declineAward(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  reason: string,
): Promise<{ awardId: string; declinedAt: string }> {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Please tell us why.', {
      internalMessage: 'declineAward with no reason',
      severity: 'warn',
      fieldErrors: [
        {
          field: 'reason',
          message: 'A sentence is enough. It helps us understand what did not work.',
        },
      ],
    });
  }

  const award = await loadOwnPendingAward(db, session, awardId);
  if (award.status !== 'pending' || award.acceptedAt) {
    throw new AppError('CONFLICT', 'This grant is no longer waiting on you.', {
      internalMessage: `declineAward on ${awardId} in status ${award.status}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  /*
   * A REFUSAL CANCELS ANY SCHEDULED PAYMENTS WITH IT, in the same batch.
   *
   * Without this the award went to `cancelled` and its payments stayed
   * `scheduled` -- still in the due index, so still on whatever list finance
   * works from -- and could then be marked paid. An adversarial review
   * reproduced $25,000 disbursed against an award the grantee had refused,
   * showing on the dashboard as paid money with nothing committed behind it.
   *
   * Cancelled rather than deleted, with a reason, like every other
   * cancellation: "we scheduled this and then did not pay it" is a question
   * somebody asks.
   */
  const [write] = await db.batch([
    db
      .prepare(
        `UPDATE awards
            SET status = 'cancelled', declined_by_grantee_at = ?,
                grantee_response_note = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND accepted_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, trimmed, now, awardId),
    db
      .prepare(
        `UPDATE payments
            SET status = 'cancelled',
                note = 'The grantee did not accept this award.',
                updated_at = ?
          WHERE award_id = ? AND status = 'scheduled' AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM awards
                         WHERE id = ? AND declined_by_grantee_at = ?)`,
      )
      .bind(now, awardId, awardId, now),
    auditStatement(db, ctx, {
      action: 'award.amended',
      entityType: 'award',
      entityId: awardId,
      before: { status: 'pending' },
      after: {
        status: 'cancelled',
        declined_by_grantee_at: now,
        grantee_response_note: trimmed,
        declined_by_user_id: session.userId,
        organization_id: award.organizationId,
      },
    }, {
      guard: {
        sql: `EXISTS (SELECT 1 FROM awards WHERE id = ? AND declined_by_grantee_at = ?)`,
        binds: [awardId, now],
      },
    }),
  ]);

  if ((write?.meta?.changes ?? 0) === 0) {
    throw new AppError('CONFLICT', 'This grant is no longer waiting on you.', {
      internalMessage: `declineAward lost a race on ${awardId}`,
      severity: 'warn',
    });
  }

  return { awardId, declinedAt: now };
}

// ---------------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------------

export const AWARD_DOCUMENTS = ['w9', 'agreement', 'media_release'] as const;
export type AwardDocument = (typeof AWARD_DOCUMENTS)[number];

const DOCUMENT_COLUMN: Record<AwardDocument, string> = {
  w9: 'w9_received_at',
  agreement: 'agreement_signed_at',
  media_release: 'media_release_at',
};

/**
 * Record that a document arrived.
 *
 * STAFF, NOT THE GRANTEE, because what is being recorded is receipt -- "we
 * have it" -- and only the Foundation knows that. A grantee marking their own
 * W-9 received would make the data health check that reads these columns
 * meaningless.
 *
 * A DATE, NOT A FILE, in this version. These documents arrive by email today
 * and an admin is confirming receipt; a column that says "received on the
 * 12th" is honest about that. Attaching the file is the obvious next step --
 * `attachments.parent_type` already admits 'award' -- and is recorded as a gap
 * rather than half-built here.
 */
export async function recordAwardDocument(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  awardId: string,
  document: AwardDocument,
  receivedAt: string | null,
): Promise<{ awardId: string; document: AwardDocument; receivedAt: string | null }> {
  if (session.role !== 'admin') throw notFound('award');
  if (!AWARD_DOCUMENTS.includes(document)) {
    throw new AppError('VALIDATION_FAILED', 'That is not a document we track.', {
      internalMessage: `unknown award document ${String(document)}`,
      severity: 'warn',
    });
  }
  const stamp = receivedAt === null ? null : receivedAt.trim() || null;
  if (stamp !== null && !Number.isFinite(Date.parse(stamp))) {
    throw new AppError('VALIDATION_FAILED', 'That is not a date we can read.', {
      internalMessage: `unparseable receipt date ${stamp}`,
      severity: 'warn',
    });
  }

  /*
   * THE SECOND PLACE IN THIS CODEBASE THAT INTERPOLATES INTO SQL, after
   * scope.ts's selectList -- so it is worth saying exactly why it is safe.
   *
   * `document` is checked against AWARD_DOCUMENTS above before we get here,
   * and DOCUMENT_COLUMN is a compile-time constant whose three values are
   * column names written in this file. Nothing a caller sends can reach the
   * query string. The validation ABOVE is what makes this safe; moving it, or
   * making DOCUMENT_COLUMN take a value from anywhere else, breaks that.
   */
  const column = DOCUMENT_COLUMN[document];
  const before = await db
    .prepare(`SELECT ${column} AS value FROM awards WHERE id = ? AND deleted_at IS NULL`)
    .bind(awardId)
    .first<{ value: string | null }>();
  if (!before) throw notFound('award');

  const now = nowIso();
  await db.batch([
    db
      .prepare(`UPDATE awards SET ${column} = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(stamp, now, awardId),
    auditStatement(db, ctx, {
      action: 'award.amended',
      entityType: 'award',
      entityId: awardId,
      // Clearing a mistaken date is a legitimate correction, and the audit row
      // is what makes it a correction rather than a disappearance.
      before: { [column]: before.value },
      after: { [column]: stamp, actor_user_id: session.userId },
    }),
  ]);

  return { awardId, document, receivedAt: stamp };
}

/**
 * The paperwork on one award: what has arrived and what has not.
 *
 * WHY IT IS SEPARATE FROM THE LEDGER. The ledger answers "what was agreed and
 * what has gone out"; this answers "what are we still waiting on before any of
 * it should". They are read side by side and written by different people --
 * finance reports a payment, an admin confirms a document arrived -- and one
 * function returning both would tie a screen about money to a screen about
 * files forever.
 *
 * IT DOES NOT ENFORCE ANYTHING, deliberately. Nothing here refuses to schedule
 * a payment because a W-9 is missing. The Foundation's own order of operations
 * is its to run, this system does not disburse money, and a hard block would
 * be this code deciding a finance question it does not have the facts for.
 * What it does is say plainly, next to the schedule, what is outstanding --
 * which is the thing nobody could see.
 *
 * ADMIN ONLY. Receipt of a grantee's W-9 is the Foundation's own record, and a
 * reviewer has no business with an award's paperwork at all.
 */
export interface AwardPaperwork {
  awardId: string;
  organizationName: string;
  status: string;
  acceptedAt: string | null;
  declinedByGranteeAt: string | null;
  /** The grantee's own words, whichever way they answered. */
  granteeResponseNote: string | null;
  documents: { key: AwardDocument; label: string; receivedAt: string | null }[];
  /** How many of the three are still missing. The number a list is sorted by. */
  outstanding: number;
  /** Money already scheduled against an award whose paperwork is incomplete. */
  scheduledCents: number;
}

const DOCUMENT_LABEL: Record<AwardDocument, string> = {
  w9: 'W-9',
  agreement: 'Signed grant agreement',
  media_release: 'Media release',
};

export async function awardPaperwork(
  db: D1Database,
  session: Session,
  awardId: string,
): Promise<AwardPaperwork> {
  if (session.role !== 'admin') throw notFound('award');

  const row = await db
    .prepare(
      `SELECT w.id, w.status, w.accepted_at AS acceptedAt,
              w.declined_by_grantee_at AS declinedByGranteeAt,
              w.grantee_response_note AS granteeResponseNote,
              w.w9_received_at AS w9, w.agreement_signed_at AS agreement,
              w.media_release_at AS mediaRelease,
              o.legal_name AS organizationName,
              COALESCE((
                SELECT SUM(p.amount_cents) FROM payments p
                 WHERE p.award_id = w.id AND p.deleted_at IS NULL
                   AND p.status <> 'cancelled'
              ), 0) AS scheduledCents
         FROM awards w
         JOIN organizations o ON o.id = w.organization_id
        WHERE w.id = ? AND w.deleted_at IS NULL`,
    )
    .bind(awardId)
    .first<{
      id: string; status: string; acceptedAt: string | null;
      declinedByGranteeAt: string | null; granteeResponseNote: string | null;
      w9: string | null; agreement: string | null; mediaRelease: string | null;
      organizationName: string; scheduledCents: number;
    }>();
  if (!row) throw notFound('award');

  const documents = [
    { key: 'w9' as const, label: DOCUMENT_LABEL.w9, receivedAt: row.w9 },
    { key: 'agreement' as const, label: DOCUMENT_LABEL.agreement, receivedAt: row.agreement },
    {
      key: 'media_release' as const,
      label: DOCUMENT_LABEL.media_release,
      receivedAt: row.mediaRelease,
    },
  ];

  return {
    awardId,
    organizationName: row.organizationName,
    status: row.status,
    acceptedAt: row.acceptedAt,
    declinedByGranteeAt: row.declinedByGranteeAt,
    granteeResponseNote: row.granteeResponseNote,
    documents,
    outstanding: documents.filter((d) => d.receivedAt === null).length,
    scheduledCents: row.scheduledCents,
  };
}
