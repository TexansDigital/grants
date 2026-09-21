/**
 * Telling applicants what was decided.
 *
 * THE HIGHEST-REPUTATION-RISK OUTPUT IN THE SYSTEM, and CLAUDE.md says so.
 * Fifty acceptances and 250 declines go out in the same week. The decline is
 * the one that gets screenshotted and forwarded, and the award is the one that
 * carries an amount to a named organization. Everything in this module is
 * shaped by the ways that week goes wrong:
 *
 *   1. A decline goes out automatically. It cannot: both templates are marked
 *      `requiresHumanRelease`, and sendEmail throws without a named releaser.
 *   2. Declines land before acceptances. An applicant who hears "no" on Monday
 *      and sees a peer celebrate on Tuesday has been told twice. Refused here.
 *   3. A grantee posts before the coordinated announcement. The award letter
 *      carries the embargo date as its own block, not a footnote.
 *   4. Somebody sends the same letter twice. The idempotency key is the
 *      application, so a double-click is one message.
 *   5. The decline says something the Foundation did not choose. The words are
 *      supplied at send time by the person releasing them; this module has no
 *      canned decline copy and will not invent any.
 *
 * WHAT "COMMUNICATED" MEANS. `decision_communicated_at` is stamped when the
 * applicant was told, by whatever means. Until it is stamped, the applicant's
 * own portal shows `under_review` rather than the outcome -- see
 * scope.ts::applicantVisibleStatus. That masking is the reason this module has
 * to stamp reliably: a letter sent without the stamp leaves a nonprofit
 * holding an award email and a portal that still says it is under review.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound, logError } from './errors';
import { nowIso, formatInZone } from './time';
import { auditStatement } from './audit';
import { sendEmail, transportFor } from './email';
import { AWARD_NOTIFICATION, DECLINE_NOTIFICATION } from './emailTemplates';
import { formatCents } from './money';

export interface PendingRow {
  applicationId: string;
  status: string;
  organizationName: string;
  projectTitle: string | null;
  contactEmail: string | null;
  decidedAt: string;
  awardedAmountCents: number | null;
  announcementDate: string | null;
}

export interface CommunicationQueue {
  cycleId: string;
  cycleName: string;
  programName: string;
  awards: PendingRow[];
  declines: PendingRow[];
  /** Awards already told. The declines gate reads this. */
  awardsCommunicated: number;
  /** True when a decline may be released: every award has gone out. */
  declinesUnlocked: boolean;
}

/**
 * What still has to go out in one cycle.
 *
 * Grouped by outcome rather than listed flat, because the order of the week is
 * the point: the awards block is worked first and the declines block is locked
 * until it is empty.
 */
export async function communicationQueue(
  db: D1Database,
  cycleId: string,
): Promise<CommunicationQueue> {
  const cycle = await db
    .prepare(
      `SELECT c.id, c.name, p.name AS programName
         FROM cycles c JOIN programs p ON p.id = c.program_id
        WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
    .bind(cycleId)
    .first<{ id: string; name: string; programName: string }>();
  if (!cycle) throw notFound('cycle');

  const { results } = await db
    .prepare(
      `SELECT a.id AS applicationId, a.status, a.project_title AS projectTitle,
              a.primary_contact_email AS contactEmail, a.decided_at AS decidedAt,
              a.decision_communicated_at AS communicatedAt,
              o.legal_name AS organizationName,
              w.awarded_amount_cents AS awardedAmountCents,
              w.announcement_date AS announcementDate
         FROM applications a
         JOIN organizations o ON o.id = a.organization_id
         LEFT JOIN awards w
           ON w.application_id = a.id AND w.deleted_at IS NULL
        WHERE a.cycle_id = ?
          AND a.decided_at IS NOT NULL
          AND a.deleted_at IS NULL
        ORDER BY o.legal_name`,
    )
    .bind(cycleId)
    .all<PendingRow & { communicatedAt: string | null }>();

  const rows = results ?? [];
  const pending = rows.filter((r) => r.communicatedAt === null);
  const awards = pending.filter((r) => r.status === 'awarded');
  const awardsCommunicated = rows.filter(
    (r) => r.status === 'awarded' && r.communicatedAt !== null,
  ).length;

  return {
    cycleId,
    cycleName: cycle.name,
    programName: cycle.programName,
    awards,
    declines: pending.filter((r) => r.status === 'declined'),
    awardsCommunicated,
    // The gate. Not "some awards went out" -- ALL of them, because the
    // applicant who hears no while one grantee is still unaware is the same
    // problem at a smaller scale.
    declinesUnlocked: awards.length === 0,
  };
}

async function loadPending(
  db: D1Database,
  applicationId: string,
): Promise<PendingRow & { cycleId: string; programName: string; communicatedAt: string | null }> {
  const row = await db
    .prepare(
      `SELECT a.id AS applicationId, a.status, a.cycle_id AS cycleId,
              a.project_title AS projectTitle,
              a.primary_contact_email AS contactEmail, a.decided_at AS decidedAt,
              a.decision_communicated_at AS communicatedAt,
              o.legal_name AS organizationName,
              p.name AS programName,
              w.awarded_amount_cents AS awardedAmountCents,
              w.announcement_date AS announcementDate
         FROM applications a
         JOIN organizations o ON o.id = a.organization_id
         JOIN cycles c ON c.id = a.cycle_id
         JOIN programs p ON p.id = c.program_id
         LEFT JOIN awards w ON w.application_id = a.id AND w.deleted_at IS NULL
        WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .bind(applicationId)
    .first<PendingRow & { cycleId: string; programName: string; communicatedAt: string | null }>();
  if (!row) throw notFound('application');
  if (!row.decidedAt) {
    throw new AppError('CONFLICT', 'This application has not been decided.', {
      internalMessage: `communication attempted on undecided ${applicationId}`,
      severity: 'warn',
    });
  }
  if (row.communicatedAt) {
    throw new AppError('CONFLICT', 'This applicant has already been told.', {
      internalMessage: `re-communication of ${applicationId}, told at ${row.communicatedAt}`,
      severity: 'warn',
    });
  }
  return row;
}

/** The statements that stamp the row and audit it. Shared by all three paths. */
/**
 * The stamp and its audit row.
 *
 * THE AUDIT INSERT IS GUARDED on the state the UPDATE creates. It was not, and
 * the consequence is the one this whole module exists to prevent: two admins
 * working the same list both stamp, the UPDATE refuses the second, and the
 * second audit row claims a communication that did not happen -- against the
 * column the applicant portal reads to decide whether to break the news.
 */
function stampStatements(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  row: { applicationId: string; status: string },
  via: 'email' | 'manual',
  now: string,
  extra: Record<string, unknown> = {},
) {
  return [
    db
      .prepare(
        `UPDATE applications
            SET decision_communicated_at = ?, decision_communicated_by = ?,
                decision_communicated_via = ?, updated_at = ?
          WHERE id = ? AND decision_communicated_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(now, session.userId, via, now, row.applicationId),
    auditStatement(db, ctx, {
      action: 'decision.communicated',
      entityType: 'application',
      entityId: row.applicationId,
      before: { decision_communicated_at: null },
      after: {
        decision_communicated_at: now,
        decision_communicated_by: session.userId,
        decision_communicated_via: via,
        status: row.status,
        ...extra,
      },
    }, {
      guard: {
        sql: `EXISTS (SELECT 1 FROM applications
                       WHERE id = ? AND decision_communicated_at = ?
                         AND decision_communicated_by = ?)`,
        binds: [row.applicationId, now, session.userId],
      },
    }),
  ];
}

export interface CommunicationResult {
  applicationId: string;
  communicatedAt: string;
  via: 'email' | 'manual';
  emailStatus?: string;
}

/**
 * Send the award letter.
 *
 * ADMIN ONLY, and released by a named person. The letter carries an amount;
 * an amount sent to the wrong organization is not a correctable email.
 *
 * THE STAMP GOES IN THE SAME BATCH AS THE AUDIT, AFTER the send. If the
 * provider refuses, nothing is stamped and the row stays in the queue -- which
 * is the recoverable failure. Stamping first and failing to send would leave a
 * nonprofit with a portal that says "awarded" and no letter, which nothing in
 * the system would ever notice.
 */
export async function sendAwardNotification(
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
): Promise<CommunicationResult> {
  if (session.role !== 'admin') throw notFound('application');
  const row = await loadPending(env.DB, applicationId);
  if (row.status !== 'awarded') {
    throw new AppError('CONFLICT', 'This application was not awarded.', {
      internalMessage: `award notification for status ${row.status}`,
      severity: 'warn',
    });
  }
  if (row.awardedAmountCents === null) {
    /*
     * An award letter with no amount is not a letter. This is also the check
     * that stops the notification going out before somebody has created the
     * award record -- a decision is not an award, and the two are separate on
     * purpose.
     */
    throw new AppError('CONFLICT', 'Create the award record before telling them the amount.', {
      internalMessage: `award notification for ${applicationId} with no award row`,
      severity: 'warn',
    });
  }
  if (!row.contactEmail) {
    throw new AppError('CONFLICT', 'This application has no contact address.', {
      internalMessage: `award notification for ${applicationId} with no contact email`,
      severity: 'error',
    });
  }

  const outcome = await sendEmail(
    env,
    ctx,
    {
      template: AWARD_NOTIFICATION,
      to: row.contactEmail,
      // The APPLICATION is the boundary, so a double-click is one message.
      idempotencyKey: `award_notification:${applicationId}`,
      releasedByUserId: session.userId,
      vars: {
        organizationName: row.organizationName,
        projectTitle: row.projectTitle,
        programName: row.programName,
        amountDisplay: formatCents(row.awardedAmountCents),
        announcementDisplay: row.announcementDate
          ? formatInZone(row.announcementDate, env.DISPLAY_TIMEZONE, {
              year: 'numeric', month: 'long', day: 'numeric',
            })
          : null,
        portalUrl: `${(env.APPLICANT_BASE_URL ?? '').trim()}/reports`,
        supportEmail: (env.EMAIL_REPLY_TO ?? '').trim(),
      },
      context: { application_id: applicationId, cycle_id: row.cycleId },
    },
    transportFor(env),
  );

  if (outcome.status === 'failed') {
    // Nothing stamped. The row stays in the queue and somebody retries, which
    // is the recoverable half of this failure.
    throw new AppError('INTERNAL', 'That letter could not be sent. Nothing was recorded.', {
      internalMessage: `award notification failed for ${applicationId}`,
      severity: 'error',
    });
  }

  const now = nowIso();
  await env.DB.batch(
    stampStatements(env.DB, ctx, session, row, 'email', now, {
      template: AWARD_NOTIFICATION.key,
      email_status: outcome.status,
    }),
  );
  return { applicationId, communicatedAt: now, via: 'email', emailStatus: outcome.status };
}

/**
 * Send one decline letter, in words a person wrote.
 *
 * TWO GATES, and both matter.
 *
 * THE WORDS. There is no canned decline copy in this system. The paragraphs
 * are supplied by the caller and the template only provides the shell.
 * `requiresHumanRelease` means sendEmail refuses without a named releaser, so
 * a decline cannot leave this system without somebody's id attached to it.
 *
 * THE ORDER. Refused while any award in the same cycle is still untold.
 * CLAUDE.md: acceptances send before declines, never the reverse. An applicant
 * who hears no on Monday and watches a peer announce on Tuesday has been told
 * twice, the second time by somebody else.
 */
export async function sendDeclineNotification(
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  bodyParagraphs: string[],
): Promise<CommunicationResult> {
  if (session.role !== 'admin') throw notFound('application');
  const row = await loadPending(env.DB, applicationId);
  if (row.status !== 'declined') {
    throw new AppError('CONFLICT', 'This application was not declined.', {
      internalMessage: `decline notification for status ${row.status}`,
      severity: 'warn',
    });
  }

  const paragraphs = bodyParagraphs.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Write the letter before sending it.', {
      internalMessage: 'decline notification with an empty body',
      severity: 'warn',
      fieldErrors: [
        {
          field: 'body',
          message:
            'This system has no standard decline wording, on purpose. Write what this ' +
            'applicant should read.',
        },
      ],
    });
  }

  const queue = await communicationQueue(env.DB, row.cycleId);
  if (!queue.declinesUnlocked) {
    throw new AppError(
      'CONFLICT',
      `${queue.awards.length} award letter${queue.awards.length === 1 ? '' : 's'} in this ` +
        `cycle have not gone out yet. Acceptances go first.`,
      {
        internalMessage: `decline blocked: ${queue.awards.length} awards uncommunicated in ${row.cycleId}`,
        severity: 'warn',
      },
    );
  }

  if (!row.contactEmail) {
    throw new AppError('CONFLICT', 'This application has no contact address.', {
      internalMessage: `decline notification for ${applicationId} with no contact email`,
      severity: 'error',
    });
  }

  const outcome = await sendEmail(
    env,
    ctx,
    {
      template: DECLINE_NOTIFICATION,
      to: row.contactEmail,
      idempotencyKey: `decline_notification:${applicationId}`,
      releasedByUserId: session.userId,
      vars: {
        organizationName: row.organizationName,
        projectTitle: row.projectTitle,
        programName: row.programName,
        bodyParagraphs: paragraphs,
        supportEmail: (env.EMAIL_REPLY_TO ?? '').trim(),
        /*
         * The portal link, because the Foundation decided declined applicants
         * keep access. There is nothing for them to do there -- the
         * application is read-only once submitted -- and that is the point:
         * they can still read what they sent us.
         */
        portalUrl: `${(env.APPLICANT_BASE_URL ?? '').trim()}/apply/${applicationId}`,
      },
      context: { application_id: applicationId, cycle_id: row.cycleId },
    },
    transportFor(env),
  );

  if (outcome.status === 'failed') {
    throw new AppError('INTERNAL', 'That letter could not be sent. Nothing was recorded.', {
      internalMessage: `decline notification failed for ${applicationId}`,
      severity: 'error',
    });
  }

  const now = nowIso();
  await env.DB.batch(
    stampStatements(env.DB, ctx, session, row, 'email', now, {
      template: DECLINE_NOTIFICATION.key,
      email_status: outcome.status,
      // The WORDS are not stored on the audit row. email_messages holds the
      // subject; the body of a letter to a third party is not something to
      // duplicate into an append-only table nobody can edit.
      paragraphs: paragraphs.length,
    }),
  );
  return { applicationId, communicatedAt: now, via: 'email', emailStatus: outcome.status };
}

/**
 * Record that somebody told them another way.
 *
 * THE LARGEST AWARDS ARE PHONED. An executive director calls; the letter
 * follows or does not. Without this, the portal would keep showing
 * `under_review` to an organization that has already been told, and the only
 * way to fix it would be to send a duplicate email to make the system behave.
 *
 * A NOTE IS REQUIRED. "Communicated manually" with no detail cannot answer the
 * question this column exists for, which is always asked in a hurry.
 */
export async function recordManualCommunication(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  note: string,
): Promise<CommunicationResult> {
  if (session.role !== 'admin') throw notFound('application');
  const trimmed = note.trim();
  if (trimmed.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Say how they were told.', {
      internalMessage: 'manual communication with no note',
      severity: 'warn',
      fieldErrors: [{ field: 'note', message: 'For example: "Called Maria, 12 Sept, spoke to her directly."' }],
    });
  }
  const row = await loadPending(db, applicationId);

  // The acceptances-first rule applies here too. Recording a manual decline
  // while awards are untold has the same consequence as sending one: the
  // applicant's portal starts saying "declined".
  if (row.status === 'declined') {
    const queue = await communicationQueue(db, row.cycleId);
    if (!queue.declinesUnlocked) {
      throw new AppError(
        'CONFLICT',
        `${queue.awards.length} award letter${queue.awards.length === 1 ? '' : 's'} in this ` +
          `cycle have not gone out yet. Acceptances go first.`,
        {
          internalMessage: `manual decline blocked: ${queue.awards.length} awards uncommunicated`,
          severity: 'warn',
        },
      );
    }
  }

  const now = nowIso();
  await db.batch(
    stampStatements(db, ctx, session, row, 'manual', now, { note: trimmed }),
  );
  return { applicationId, communicatedAt: now, via: 'manual' };
}

// ---------------------------------------------------------------------------
// Sending the week's declines
// ---------------------------------------------------------------------------

/**
 * How many letters one request sends.
 *
 * NOT ALL OF THEM, and this is a deliberate limit rather than a timid one. A
 * cycle produces around 250 declines; each is an HTTPS call to a mail
 * provider. A Worker that tried the lot in one request would be betting the
 * whole batch on staying inside the subrequest limit and the CPU budget, and
 * the failure mode is the worst available: a request that dies at letter 180
 * with nobody able to say which 180.
 *
 * Twenty-five is small enough to finish comfortably and large enough that 250
 * letters is ten rounds rather than 250. The caller loops until `remaining` is
 * zero, and because every letter is keyed on its own application, a repeated
 * round sends nothing twice.
 */
export const DECLINE_BATCH_SIZE = 25;

export interface BatchOutcome {
  applicationId: string;
  organizationName: string;
  ok: boolean;
  /** Present only when it did not go. Plain enough to act on. */
  reason: string | null;
}

export interface DeclineBatchResult {
  sent: number;
  failed: number;
  /** Still waiting after this round. The caller loops while this is above 0. */
  remaining: number;
  outcomes: BatchOutcome[];
}

/**
 * Send one round of decline letters, all carrying the same words.
 *
 * ONE LETTER, MANY RECIPIENTS, and the words are still typed by a person. The
 * single-send path exists for the decline that needs its own wording; this is
 * for the 240 that say the same thing, which is the honest majority and the
 * reason a week of declines currently takes an afternoon.
 *
 * THE GATE IS CHECKED ONCE, HERE, AND AGAIN PER LETTER. Once because a batch
 * refused wholesale is a better message than 250 individual refusals; per
 * letter because sendDeclineNotification is the function that must not be
 * bypassable, and a batch wrapper that skipped its checks would be exactly the
 * bypass.
 *
 * ONE FAILURE DOES NOT STOP THE ROUND. A single bad address should not hold up
 * 24 other nonprofits, and the outcome list names who did not get theirs so
 * somebody can act on it rather than discovering it in a reply three weeks
 * later.
 */
export async function sendDeclineBatch(
  env: Env,
  ctx: RequestContext,
  session: Session,
  cycleId: string,
  bodyParagraphs: string[],
  limit: number = DECLINE_BATCH_SIZE,
): Promise<DeclineBatchResult> {
  if (session.role !== 'admin') throw notFound('cycle');

  const paragraphs = bodyParagraphs.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Write the letter before sending it.', {
      internalMessage: 'decline batch with an empty body',
      severity: 'warn',
      fieldErrors: [
        {
          field: 'body',
          message:
            'This system has no standard decline wording, on purpose. Write what these ' +
            'applicants should read.',
        },
      ],
    });
  }

  const queue = await communicationQueue(env.DB, cycleId);
  if (!queue.declinesUnlocked) {
    throw new AppError(
      'CONFLICT',
      `${queue.awards.length} award letter${queue.awards.length === 1 ? '' : 's'} in this ` +
        `cycle have not gone out yet. Acceptances go first.`,
      {
        internalMessage: `decline batch blocked: ${queue.awards.length} awards uncommunicated`,
        severity: 'warn',
      },
    );
  }

  const round = queue.declines.slice(0, Math.max(1, Math.min(limit, DECLINE_BATCH_SIZE)));
  const outcomes: BatchOutcome[] = [];

  for (const row of round) {
    try {
      await sendDeclineNotification(env, ctx, session, row.applicationId, paragraphs);
      outcomes.push({
        applicationId: row.applicationId,
        organizationName: row.organizationName,
        ok: true,
        reason: null,
      });
    } catch (err) {
      /*
       * The PUBLIC message, not the internal one. This list is read by an
       * admin deciding what to do about each failure, and "no contact
       * address" tells them to go and find one where a stack trace does not.
       */
      const reason =
        err instanceof AppError ? err.publicMessage : 'That letter could not be sent.';
      outcomes.push({
        applicationId: row.applicationId,
        organizationName: row.organizationName,
        ok: false,
        reason,
      });
      await logError(env, ctx, {
        severity: 'error',
        code: 'DECLINE_BATCH_ITEM_FAILED',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: { application_id: row.applicationId, cycle_id: cycleId },
      });
    }
  }

  const sent = outcomes.filter((o) => o.ok).length;
  return {
    sent,
    failed: outcomes.length - sent,
    /*
     * RE-READ, not arithmetic. `queue.declines.length - sent` would be wrong
     * the moment a colleague sends one from the single-send screen while this
     * batch is running, and the caller loops on this number.
     */
    remaining: (await communicationQueue(env.DB, cycleId)).declines.length,
    outcomes,
  };
}
