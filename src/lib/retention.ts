/**
 * Destroying uploaded financial documents on a schedule.
 *
 * WHY THIS EXISTS. Nonprofits hand this system their audited financial
 * statements, their full operating budget and an itemized spending budget in
 * order to be considered for a grant. Those documents belong to them. The
 * Foundation's reason for holding them ends when the decision is made, and
 * everything held after that is exposure with no purpose -- a breach of a
 * grants platform that has kept nine years of third-party audited accounts is
 * a different event from one that has kept ninety days.
 *
 * WHAT WAS PROPOSED AND WHY IT IS NOT WHAT THIS DOES. The original idea was to
 * email the documents to the key admins and then remind them to delete their
 * copies. Mailing them multiplies the copies instead of reducing them: the
 * outbox, both mailboxes, the mail provider, its backups, every phone those
 * accounts are signed into, and anywhere the message is forwarded. Steward can
 * destroy its own copy on schedule. It can never destroy those. A daily
 * reminder to delete is a request, not a control, and it is filtered within a
 * week.
 *
 * So the files never leave R2, and the notice that goes out carries a LINK and
 * no attachment. Whoever needs a document opens it through Steward, where the
 * read is scoped, five minutes long, and written to the audit log.
 *
 * WHAT THE NOTICES ACTUALLY MEASURE. A digest stops naming a file once a
 * download URL has been ISSUED for it -- which is not the same as the bytes
 * having been fetched, because downloads go straight from the browser to R2
 * and this system never sees them. The wording of the email says so. Somebody
 * deciding whether it is safe to let a financial statement be destroyed should
 * not be told "you have a copy" by a system that cannot know that.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound, logError } from './errors';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { sendEmail, transportFor } from './email';
import { FILES_DUE_FOR_DELETION } from './emailTemplates';
import { formatInZone } from './time';

/**
 * Ninety days after the decision.
 *
 * Long enough to answer a question about a decision that was just made, short
 * enough that a breach next year does not expose this year's applicants. The
 * number is the Foundation's to change; it is read from configuration rather
 * than hard-coded so changing it does not mean changing this file.
 *
 * NOT a per-program setting yet. CLAUDE.md puts compliance policy on the
 * program, and retention belongs there eventually. One number for every
 * program is honest about where this has got to, and is recorded as a gap.
 */
export const RETENTION_DAYS_DEFAULT = 90;

/** How far ahead a notice looks. The first warning lands a month out. */
export const WARN_HORIZON_DAYS = 30;

/** Inside this many days, the notice goes daily rather than once. */
export const DAILY_WITHIN_DAYS = 7;

export function retentionDays(env: Env): number {
  const raw = Number((env.RETENTION_DAYS ?? '').toString().trim());
  if (!Number.isInteger(raw) || raw < 1) return RETENTION_DAYS_DEFAULT;
  return raw;
}

// ---------------------------------------------------------------------------
// Step 1 — what is due
// ---------------------------------------------------------------------------

/**
 * Recompute `purge_due_at` for every application attachment still holding
 * bytes.
 *
 * RECOMPUTED, NOT STAMPED ONCE. Decisions get reversed, awards get created
 * weeks after a decision, terms get extended. A date stamped at decision time
 * is a snapshot of one evening's facts; this one follows them.
 *
 * TWO CONDITIONS SUSPEND IT, both expressed as NULL:
 *
 *   - The application has not been decided. The review still needs the budget.
 *   - A pending or active award arose from it. The itemized budget is what the
 *     award was made against and what the grantee's spending is later checked
 *     against; destroying it would mean holding a grantee to a document the
 *     Foundation threw away.
 *
 * strftime rather than datetime(), because datetime() returns
 * 'YYYY-MM-DD HH:MM:SS' and every other timestamp in this database is ISO-8601
 * with milliseconds and a Z. Two formats in one column compare as strings in
 * whatever order the characters happen to fall, which is how a file gets
 * destroyed early.
 */
export async function recomputeDueDates(
  db: D1Database,
  days: number,
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE attachments
          SET purge_due_at = (
            SELECT CASE
              -- EXPLICIT, THOUGH REDUNDANT TODAY. A mutation run showed that
              -- removing this branch changes nothing, because SQLite's
              -- strftime returns NULL for a NULL input and the ELSE therefore
              -- already yields NULL for an undecided application. It stays
              -- because the redundancy is accidental: the day somebody writes
              -- COALESCE(a.decided_at, a.submitted_at) in the ELSE -- a
              -- plausible "be more robust" edit -- NULL stops propagating and
              -- every application still under review gets a deletion date for
              -- its financial statements. This line is what refuses that.
              WHEN a.decided_at IS NULL THEN NULL
              WHEN EXISTS (
                SELECT 1 FROM awards w
                 WHERE w.application_id = a.id
                   AND w.deleted_at IS NULL
                   AND w.status IN ('pending','active')
              ) THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', a.decided_at, '+' || ? || ' days')
            END
            FROM applications a
           WHERE a.id = attachments.parent_id AND a.deleted_at IS NULL
          )
        WHERE parent_type = 'application'
          AND parent_id IS NOT NULL
          AND purged_at IS NULL
          AND deleted_at IS NULL`,
    )
    .bind(days)
    .run();
  return res.meta.changes ?? 0;
}

export interface DueFile {
  id: string;
  filename: string;
  organization_name: string;
  project_title: string | null;
  application_id: string;
  effective_due_at: string;
  download_url_first_issued_at: string | null;
}

/**
 * The effective date: the computed one, or an admin's hold if that is later.
 *
 * Written once, here, and reused by the query that warns and the query that
 * destroys. Two copies of this expression is how a file gets warned about on
 * one schedule and deleted on another.
 */
const EFFECTIVE_DUE = `MAX(a.purge_due_at, COALESCE(a.retention_hold_until, a.purge_due_at))`;

/** Files due within `horizonDays`, newest deadline last. */
export async function filesDueWithin(
  db: D1Database,
  nowIsoStr: string,
  horizonDays: number,
): Promise<DueFile[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.filename, a.download_url_first_issued_at,
              ${EFFECTIVE_DUE} AS effective_due_at,
              app.id AS application_id, app.project_title,
              o.legal_name AS organization_name
         FROM attachments a
         JOIN applications app  ON app.id = a.parent_id
         JOIN organizations o   ON o.id = app.organization_id
        WHERE a.parent_type = 'application'
          AND a.purge_due_at IS NOT NULL
          AND a.purged_at IS NULL
          AND a.deleted_at IS NULL
          AND ${EFFECTIVE_DUE} <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' days')
        ORDER BY effective_due_at, o.legal_name, a.filename`,
    )
    .bind(nowIsoStr, horizonDays)
    .all<DueFile>();
  return results ?? [];
}

/** Files whose time is up. Same expression, no horizon. */
export async function filesPastDue(db: D1Database, nowIsoStr: string): Promise<
  { id: string; r2_key: string; filename: string; organization_id: string | null; parent_id: string | null }[]
> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.r2_key, a.filename, a.organization_id, a.parent_id
         FROM attachments a
        WHERE a.parent_type = 'application'
          AND a.purge_due_at IS NOT NULL
          AND a.purged_at IS NULL
          AND a.deleted_at IS NULL
          AND ${EFFECTIVE_DUE} <= ?`,
    )
    .bind(nowIsoStr)
    .all<{ id: string; r2_key: string; filename: string; organization_id: string | null; parent_id: string | null }>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Step 2 — destroying the bytes
// ---------------------------------------------------------------------------

/**
 * Destroy one object and stamp the row.
 *
 * THE ORDER IS DELIBERATE: R2 first, database second.
 *
 * Both orders can fail halfway, so the question is which halfway state is
 * survivable. Stamping first and failing to delete leaves a row that SAYS the
 * document was destroyed while the document is still there -- a false
 * statement about a liability, and one nothing will ever correct, because the
 * job skips anything already stamped. Deleting first and failing to stamp
 * leaves bytes gone and unrecorded, which tomorrow's run fixes: R2 treats a
 * delete of a missing key as success, so the retry deletes nothing and stamps
 * correctly.
 *
 * The window between the two is the one case where a download URL can be
 * issued for an object that no longer exists. The caller gets a link that 404s
 * at R2 rather than a clear message, for at most one night.
 */
async function purgeOne(
  env: Env,
  ctx: RequestContext,
  file: { id: string; r2_key: string; filename: string; organization_id: string | null },
  reason: string,
  actorUserId: string | null,
): Promise<void> {
  await env.FILES.delete(file.r2_key);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE attachments SET purged_at = ? WHERE id = ? AND purged_at IS NULL`,
    ).bind(now, file.id),
    auditStatement(env.DB, ctx, {
      action: 'attachment.purged',
      entityType: 'attachment',
      entityId: file.id,
      before: { purged_at: null, filename: file.filename },
      after: {
        purged_at: now,
        filename: file.filename,
        organization_id: file.organization_id,
        reason,
        // Named so the log distinguishes the nightly job from an admin who
        // pressed delete. Both are legitimate; they are not the same event.
        actor_user_id: actorUserId,
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Step 3 — the nightly run
// ---------------------------------------------------------------------------

export interface RetentionRun {
  recomputed: number;
  purged: number;
  purgeFailures: number;
  dueWithinHorizon: number;
  notRetrieved: number;
  /**
   * Message ROWS written, not deliveries. An environment with no provider key
   * records every notice as `suppressed`, which is a successful outcome for a
   * staging database that must never mail anyone -- and counting it as a send
   * would be this system telling itself something it does not know.
   */
  noticesRecorded: number;
}

/**
 * Should a notice go out tonight?
 *
 * The Foundation's rule: one heads-up a month out, then EVERY DAY through the
 * last week until the file has been asked for. So a notice is warranted when
 * anything not yet retrieved is inside the daily window, or when something
 * crosses the horizon today.
 *
 * Nothing not yet retrieved means no notice. A daily email that is empty
 * teaches the recipient to filter it, and the one that matters arrives after
 * the filter is in place.
 */
export function noticeIsDue(files: DueFile[], nowMs: number): DueFile[] {
  const cutoff = nowMs + DAILY_WITHIN_DAYS * 86_400_000;
  const outstanding = files.filter((f) => !f.download_url_first_issued_at);
  if (outstanding.length === 0) return [];
  const urgent = outstanding.some((f) => Date.parse(f.effective_due_at) <= cutoff);
  // Outside the last week, one notice a day would be thirty of them. The
  // month-out heads-up is the day a file first enters the horizon.
  const arrivingToday = outstanding.some(
    (f) =>
      Date.parse(f.effective_due_at) > cutoff &&
      Date.parse(f.effective_due_at) <= nowMs + WARN_HORIZON_DAYS * 86_400_000 &&
      Date.parse(f.effective_due_at) > nowMs + (WARN_HORIZON_DAYS - 1) * 86_400_000,
  );
  return urgent || arrivingToday ? outstanding : [];
}

/**
 * Recompute, destroy what is due, and tell the admins what is coming.
 *
 * ORDER MATTERS: purge before notice, so tonight's email never names a file
 * that was destroyed an instant earlier.
 *
 * A FAILURE TO DELETE ONE OBJECT DOES NOT STOP THE REST. Each file is its own
 * try block and its own audit row. The alternative -- one exception abandoning
 * the run -- means a single unreachable key keeps every other applicant's
 * accounts alive indefinitely, and the failure is invisible because the job
 * looks like it merely had nothing to do.
 */
export async function runRetention(
  env: Env,
  ctx: RequestContext,
  now: Date = new Date(),
): Promise<RetentionRun> {
  const nowStr = now.toISOString();
  const days = retentionDays(env);

  const recomputed = await recomputeDueDates(env.DB, days);

  let purged = 0;
  let purgeFailures = 0;
  for (const file of await filesPastDue(env.DB, nowStr)) {
    try {
      await purgeOne(env, ctx, file, `retention: ${days} days after the decision`, null);
      purged += 1;
    } catch (err) {
      purgeFailures += 1;
      await logError(env, ctx, {
        severity: 'error',
        code: 'RETENTION_PURGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: { attachment_id: file.id },
      });
    }
  }

  const due = await filesDueWithin(env.DB, nowStr, WARN_HORIZON_DAYS);
  const outstanding = noticeIsDue(due, now.getTime());
  let noticesRecorded = 0;
  if (outstanding.length > 0) {
    noticesRecorded = await sendRetentionNotices(env, ctx, outstanding, now);
  }

  return {
    recomputed,
    purged,
    purgeFailures,
    dueWithinHorizon: due.length,
    notRetrieved: due.filter((f) => !f.download_url_first_issued_at).length,
    noticesRecorded,
  };
}

/**
 * One digest per admin per day.
 *
 * The idempotency key carries the calendar date, so a cron that fires twice --
 * a retry, an overlapping run, a manual trigger -- produces one email. That
 * guarantee is in the database's UNIQUE index rather than in an assumption
 * about how often the scheduler runs.
 *
 * ADMINS ONLY. A reviewer cannot extend a hold or delete early, so a notice to
 * one is a message about something they cannot act on.
 */
async function sendRetentionNotices(
  env: Env,
  ctx: RequestContext,
  files: DueFile[],
  now: Date,
): Promise<number> {
  const { results: admins } = await env.DB.prepare(
    `SELECT id, email FROM users
      WHERE role = 'admin' AND is_active = 1 AND deleted_at IS NULL
      ORDER BY email`,
  ).all<{ id: string; email: string }>();
  if (!admins || admins.length === 0) return 0;

  // A deletion date is a day, not a moment. Showing "11:04 PM CDT" on a
  // retention notice invites somebody to believe the minute matters.
  const dateOnly: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'long', day: 'numeric',
  };
  const day = now.toISOString().slice(0, 10);
  const transport = transportFor(env);
  const soonest = files.reduce(
    (min, f) => (Date.parse(f.effective_due_at) < Date.parse(min) ? f.effective_due_at : min),
    files[0]!.effective_due_at,
  );

  let sent = 0;
  for (const admin of admins) {
    const outcome = await sendEmail(
      env,
      ctx,
      {
        template: FILES_DUE_FOR_DELETION,
        to: admin.email,
        idempotencyKey: `retention_notice:${admin.id}:${day}`,
        vars: {
          fileCount: files.length,
          soonestDueDisplay: formatInZone(soonest, env.DISPLAY_TIMEZONE, dateOnly),
          lines: files.slice(0, 40).map((f) => ({
            organization: f.organization_name,
            filename: f.filename,
            dueDisplay: formatInZone(f.effective_due_at, env.DISPLAY_TIMEZONE, dateOnly),
          })),
          truncated: Math.max(0, files.length - 40),
          reviewUrl: `${(env.STAFF_BASE_URL ?? '').trim()}/retention`,
        },
        context: { day, file_count: files.length },
      },
      transport,
    );
    if (outcome.status === 'sent' || outcome.status === 'suppressed') sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

/**
 * Push one file's deletion date out, with a reason.
 *
 * A reason is REQUIRED, and the schema enforces it too. An extension is the
 * Foundation choosing to keep another organization's audited accounts longer
 * than its own policy says; "why" is the whole record of that choice, and an
 * extension nobody can account for is exactly what an auditor asks about.
 */
export async function holdAttachment(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  attachmentId: string,
  untilIsoStr: string,
  reason: string,
): Promise<{ attachmentId: string; holdUntil: string }> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new AppError('VALIDATION_FAILED', 'Say why this file is being kept longer.', {
      internalMessage: 'retention hold with no reason',
      severity: 'warn',
    });
  }
  const until = Date.parse(untilIsoStr);
  if (!Number.isFinite(until)) {
    throw new AppError('VALIDATION_FAILED', 'That is not a date we can read.', {
      internalMessage: `retention hold with unparseable date ${untilIsoStr}`,
      severity: 'warn',
    });
  }
  if (until <= Date.now()) {
    // A hold in the past does not shorten anything -- the effective date is the
    // LATER of the two -- so it would silently do nothing. Refusing says so.
    throw new AppError('VALIDATION_FAILED', 'A hold has to be in the future.', {
      internalMessage: `retention hold ${untilIsoStr} is not in the future`,
      severity: 'warn',
    });
  }

  const row = await db
    .prepare(
      `SELECT id, filename, retention_hold_until, purged_at FROM attachments
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(attachmentId)
    .first<{ id: string; filename: string; retention_hold_until: string | null; purged_at: string | null }>();
  if (!row) throw notFound('file');
  if (row.purged_at) {
    throw new AppError('CONFLICT', 'This file has already been deleted.', {
      internalMessage: `retention hold on attachment ${attachmentId} purged at ${row.purged_at}`,
      severity: 'warn',
    });
  }

  const now = nowIso();
  const holdUntil = new Date(until).toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE attachments
            SET retention_hold_until = ?, retention_reason = ?,
                retention_set_by = ?, retention_set_at = ?
          WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL`,
      )
      .bind(holdUntil, trimmed, session.userId, now, attachmentId),
    auditStatement(db, ctx, {
      action: 'attachment.retention_held',
      entityType: 'attachment',
      entityId: attachmentId,
      before: { retention_hold_until: row.retention_hold_until },
      after: { retention_hold_until: holdUntil, reason: trimmed, filename: row.filename },
    }),
  ]);

  return { attachmentId, holdUntil };
}

/**
 * Destroy one file now, ahead of its date.
 *
 * The other half of an admin's control. A document that should never have been
 * uploaded -- a W-9 attached to the wrong field, a board member's personal tax
 * return -- should not sit in R2 for ninety days because the policy says so.
 */
export async function purgeAttachmentNow(
  env: Env,
  ctx: RequestContext,
  session: Session,
  attachmentId: string,
  reason: string,
): Promise<{ attachmentId: string; purgedAt: string }> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new AppError('VALIDATION_FAILED', 'Say why this file is being deleted now.', {
      internalMessage: 'early purge with no reason',
      severity: 'warn',
    });
  }

  const row = await env.DB.prepare(
    `SELECT id, r2_key, filename, organization_id, purged_at FROM attachments
      WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(attachmentId)
    .first<{
      id: string;
      r2_key: string;
      filename: string;
      organization_id: string | null;
      purged_at: string | null;
    }>();
  if (!row) throw notFound('file');
  if (row.purged_at) {
    throw new AppError('CONFLICT', 'This file has already been deleted.', {
      internalMessage: `early purge of attachment ${attachmentId} purged at ${row.purged_at}`,
      severity: 'warn',
    });
  }

  await purgeOne(env, ctx, row, trimmed, session.userId);
  const purged = await env.DB.prepare(`SELECT purged_at FROM attachments WHERE id = ?`)
    .bind(attachmentId)
    .first<{ purged_at: string }>();
  return { attachmentId, purgedAt: purged!.purged_at };
}

/**
 * The screen: everything with a date, whether or not it has been retrieved.
 *
 * Purged rows are INCLUDED, with their stamp. A retention screen that hides
 * what it destroyed cannot answer the only question anyone will ever ask it --
 * "what happened to the budget we had from them in March".
 */
export async function retentionScreen(
  db: D1Database,
  nowIsoStr: string,
): Promise<{ upcoming: DueFile[]; purged: Record<string, unknown>[] }> {
  const upcoming = await filesDueWithin(db, nowIsoStr, WARN_HORIZON_DAYS);
  const { results: purged } = await db
    .prepare(
      `SELECT a.id, a.filename, a.purged_at, o.legal_name AS organization_name,
              app.id AS application_id
         FROM attachments a
         JOIN applications app ON app.id = a.parent_id
         JOIN organizations o  ON o.id = app.organization_id
        WHERE a.purged_at IS NOT NULL AND a.deleted_at IS NULL
        ORDER BY a.purged_at DESC
        LIMIT 200`,
    )
    .all<Record<string, unknown>>();
  return { upcoming, purged: purged ?? [] };
}

