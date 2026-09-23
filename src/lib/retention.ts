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
import { formatDayInZone } from './time';

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

/**
 * Retention for files attached to a GRANT REPORT, which is a different problem.
 *
 * WHY THIS IS NOT THE SAME RULE WITH A DIFFERENT NUMBER. An applicant's audited
 * accounts are collected from three hundred organizations in order to fund
 * fifty, and once the decision is made the Foundation's reason for holding
 * them is over: everything after that is exposure with no purpose. A photo of
 * the thing the grant paid for is the opposite. It is not evidence gathered to
 * reach a decision, it is the deliverable -- the reason for asking. Purging it
 * on a ninety-day clock would destroy exactly what it was collected for, and a
 * grantee who sent a video of their summer program would find it gone before
 * the annual report that was supposed to carry it.
 *
 * So media is never scheduled for deletion here. Not "kept for a long time":
 * never scheduled, at all. A photo or a video leaves only when an admin purges
 * that one file deliberately, through purgeAttachmentNow, which already exists
 * and already writes an audit row.
 *
 * WHY IT IS OFF UNLESS SOMEBODY TURNS IT ON. Documents attached to a report --
 * a financial summary, an evaluation -- are closer to the application case, and
 * a retention window for them is defensible. It is also decision 3.8 in
 * docs/BLOCKED-ON-YOU.md, which is the Foundation's to make. Building it with a
 * default would be deciding it by whichever behaviour got written first, which
 * is the failure mode CLAUDE.md names for exactly this kind of fork. With
 * REPORT_RETENTION_DAYS unset nothing is scheduled and nothing is deleted; the
 * data-health screen reports the files as unretained so the absence is visible
 * rather than assumed.
 *
 * WHAT COUNTS AS MEDIA. The stored mime type, which is the same value
 * mimeForUpload resolved at upload and the same one every other surface reads.
 * A budget scanned to a PNG is therefore treated as media and kept. That is the
 * safe direction to be wrong in: the cost of keeping a file too long is known
 * and bounded, and the cost of destroying somebody's only copy is not.
 */
export function reportRetentionDays(env: Env): number | null {
  const raw = Number((env.REPORT_RETENTION_DAYS ?? '').toString().trim());
  if (!Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

/**
 * Schedule report DOCUMENTS for deletion, measured from acceptance.
 *
 * From acceptance rather than from submission: a report under review is a
 * report somebody may still have to read, and the attachment is part of what
 * they are reading. An unaccepted report yields NULL and is never scheduled --
 * the same shape as an undecided application above, and for the same reason.
 *
 * Returns the number of rows touched, or 0 when no window is configured.
 */
export async function recomputeReportDueDates(
  db: D1Database,
  days: number | null,
): Promise<number> {
  // No window, no schedule. Not "a very long window": none.
  if (days === null) return 0;
  const res = await db
    .prepare(
      `UPDATE attachments
          SET purge_due_at = (
            SELECT CASE
              WHEN rs.accepted_at IS NULL THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', rs.accepted_at, '+' || ? || ' days')
            END
            FROM report_submissions rs
           WHERE rs.id = attachments.parent_id AND rs.deleted_at IS NULL
          )
        WHERE parent_type = 'report_submission'
          AND parent_id IS NOT NULL
          AND purged_at IS NULL
          AND deleted_at IS NULL
          -- Media is never scheduled. See the note above; this is the line
          -- that keeps a grantee's photographs out of the purge queue, and
          -- deleting it would put every one of them in it.
          AND COALESCE(mime_type, '') NOT LIKE 'image/%'
          AND COALESCE(mime_type, '') NOT LIKE 'video/%'`,
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
  /*
   * Null for a file attached to a grant report. A report document has no
   * application behind it -- an award can outlive the application that earned
   * it, and a renewal has none of its own -- so this is a link where one
   * exists and nothing where one does not, rather than an id invented to keep
   * the column non-null.
   */
  application_id: string | null;
  /** 'application' or 'report_submission'. What the file is attached to. */
  parent_type: string;
  effective_due_at: string;
  download_url_first_issued_at: string | null;
  /** When this file was last named in a notice. Null means never. */
  retention_notice_sent_at: string | null;
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
      /*
       * BOTH kinds of attachment, in one list, because there is one person
       * deciding and they should get one email. The joins are LEFT and the
       * organization name is coalesced across them: a row that matches neither
       * side would otherwise vanish from the warning while staying perfectly
       * eligible for deletion, which is the one combination that must not
       * happen -- a file destroyed without ever appearing in a notice.
       */
      `SELECT a.id, a.filename, a.download_url_first_issued_at,
              a.retention_notice_sent_at, a.parent_type,
              ${EFFECTIVE_DUE} AS effective_due_at,
              app.id AS application_id,
              COALESCE(app.project_title, rp.label) AS project_title,
              COALESCE(o.legal_name, ro.legal_name, '(unknown organization)')
                AS organization_name
         FROM attachments a
         LEFT JOIN applications app       ON app.id = a.parent_id
                                         AND a.parent_type = 'application'
         LEFT JOIN organizations o        ON o.id = app.organization_id
         LEFT JOIN report_submissions rs  ON rs.id = a.parent_id
                                         AND a.parent_type = 'report_submission'
         LEFT JOIN report_periods rp      ON rp.id = rs.report_period_id
         LEFT JOIN awards w               ON w.id = rp.award_id
         LEFT JOIN organizations ro       ON ro.id = w.organization_id
        WHERE a.parent_type IN ('application', 'report_submission')
          AND a.purge_due_at IS NOT NULL
          AND a.purged_at IS NULL
          AND a.deleted_at IS NULL
          AND ${EFFECTIVE_DUE} <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' days')
        ORDER BY effective_due_at, organization_name, a.filename`,
    )
    .bind(nowIsoStr, horizonDays)
    .all<DueFile>();
  return results ?? [];
}

/** Files whose time is up. Same expression, no horizon. */
export interface PastDueFile {
  id: string;
  r2_key: string;
  filename: string;
  organization_id: string | null;
  parent_id: string | null;
  parent_type: string;
}

export async function filesPastDue(db: D1Database, nowIsoStr: string): Promise<PastDueFile[]> {
  const { results } = await db
    .prepare(
      /*
       * The set here MUST be the same set filesDueWithin warns about, or a file
       * is destroyed that nobody was told about. That is why both read
       * EFFECTIVE_DUE and why both list the same parent types; the two queries
       * disagreeing is the failure this pair is arranged to prevent.
       *
       * A report's photographs never reach here, because nothing ever writes
       * them a purge_due_at. See recomputeReportDueDates.
       */
      `SELECT a.id, a.r2_key, a.filename, a.organization_id, a.parent_id, a.parent_type
         FROM attachments a
        WHERE a.parent_type IN ('application', 'report_submission')
          AND a.purge_due_at IS NOT NULL
          AND a.purged_at IS NULL
          AND a.deleted_at IS NULL
          AND ${EFFECTIVE_DUE} <= ?`,
    )
    .bind(nowIsoStr)
    .all<PastDueFile>();
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
 * inside the horizon has never been warned about at all.
 *
 * THE HEADS-UP USED TO BE A CLOCK CALCULATION AND IS NOW A FACT ABOUT THE
 * FILE. It fired only for files whose deletion date fell between 29 and 30
 * days from the exact instant the run began -- a one-day slice that is
 * contiguous with the previous night's only if the cron fires at precisely the
 * same moment every night. A missed run, a late retry, or an admin releasing a
 * hold that drops a date into the middle of the slice skipped the warning
 * outright, and skipped it silently. `retention_notice_sent_at` (0022) records
 * whether the file has ever been named, so a missed night delays the heads-up
 * by a night instead of losing it.
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
  // month-out heads-up is the first night a file is seen inside the horizon.
  const neverWarned = outstanding.some((f) => f.retention_notice_sent_at === null);
  return urgent || neverWarned ? outstanding : [];
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
  /*
   * Returns 0 and writes nothing unless REPORT_RETENTION_DAYS is set. Report
   * documents have no retention window until the Foundation chooses one, and a
   * grantee's photographs have none at all by design.
   */
  const reportDays = reportRetentionDays(env);
  await recomputeReportDueDates(env.DB, reportDays);

  let purged = 0;
  let purgeFailures = 0;
  for (const file of await filesPastDue(env.DB, nowStr)) {
    try {
      /*
       * The reason is written onto the audit row, so it has to be true of THIS
       * file. "90 days after the decision" on a report document would describe
       * a decision that never happened to it.
       */
      const reason =
        file.parent_type === 'report_submission'
          ? `retention: ${reportDays} days after the report was accepted`
          : `retention: ${days} days after the decision`;
      await purgeOne(env, ctx, file, reason, null);
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
    /*
     * STAMPED ONLY IF A NOTICE ROW WAS ACTUALLY WRITTEN. A database with no
     * active admin records nothing and sends nothing; stamping anyway would
     * mark every one of those files as warned about, and the first admin
     * account created afterwards would never receive the heads-up for any of
     * them. `sendRetentionNotices` counts a suppressed message as recorded on
     * purpose -- a staging environment with no provider key has still written
     * down that the notice was due.
     */
    if (noticesRecorded > 0) {
      await stampNoticed(env.DB, outstanding.map((f) => f.id), nowStr);
    }
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

  /*
   * A deletion date is a day, not a moment. Showing "11:04 PM CDT" on a
   * retention notice invites somebody to believe the minute matters.
   *
   * THIS COMMENT WAS TRUE AND THE CODE WAS NOT. It passed `{year, month, day}`
   * to formatInZone, which merges over defaults that include the time -- so
   * every notice since this was written has carried an hour on a date that has
   * none. `formatDayInZone` is the function that does what this paragraph says.
   */
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
          soonestDueDisplay: formatDayInZone(soonest, env.DISPLAY_TIMEZONE),
          lines: files.slice(0, 40).map((f) => ({
            organization: f.organization_name,
            filename: f.filename,
            dueDisplay: formatDayInZone(f.effective_due_at, env.DISPLAY_TIMEZONE),
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

/**
 * Write down that these files have been named in a notice.
 *
 * NO AUDIT ROW. CLAUDE.md requires one for "every status, score, decision,
 * award and payment write"; this is none of those. It is the notice's own
 * bookkeeping, and the notice itself is already a message row with an
 * idempotency key. An audit entry per file per night would bury the rows that
 * matter -- the holds and the destructions -- under thirty times their number.
 *
 * CHUNKED, because the horizon can hold a whole cycle's uploads and a single
 * statement with several hundred bound parameters is a limit nobody wants to
 * discover on the one night it matters.
 */
async function stampNoticed(db: D1Database, ids: string[], nowIsoStr: string): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    await db
      .prepare(
        `UPDATE attachments SET retention_notice_sent_at = ?
          WHERE id IN (${slice.map(() => '?').join(',')})
            AND purged_at IS NULL AND deleted_at IS NULL`,
      )
      .bind(nowIsoStr, ...slice)
      .run();
  }
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
                retention_set_by = ?, retention_set_at = ?,
                -- A HOLD EARNS A FRESH HEADS-UP. The file leaves the horizon
                -- and will come back into it weeks later; without clearing
                -- this it would re-enter already marked as warned about, and
                -- the only notice it ever got would be the one from before the
                -- extension, about a date that no longer applies.
                retention_notice_sent_at = NULL
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
      /*
       * LEFT, not INNER. This is the record of what was destroyed, and an
       * INNER JOIN quietly drops any purged file whose parent is not an
       * application -- so a report document deleted last month would be absent
       * from the one screen whose whole job is answering "what happened to the
       * file we had from them".
       */
      `SELECT a.id, a.filename, a.purged_at, a.parent_type,
              COALESCE(o.legal_name, ro.legal_name, '(unknown organization)')
                AS organization_name,
              app.id AS application_id
         FROM attachments a
         LEFT JOIN applications app      ON app.id = a.parent_id
                                        AND a.parent_type = 'application'
         LEFT JOIN organizations o       ON o.id = app.organization_id
         LEFT JOIN report_submissions rs ON rs.id = a.parent_id
                                        AND a.parent_type = 'report_submission'
         LEFT JOIN report_periods rp     ON rp.id = rs.report_period_id
         LEFT JOIN awards w              ON w.id = rp.award_id
         LEFT JOIN organizations ro      ON ro.id = w.organization_id
        WHERE a.purged_at IS NOT NULL AND a.deleted_at IS NULL
        ORDER BY a.purged_at DESC
        LIMIT 200`,
    )
    .all<Record<string, unknown>>();
  return { upcoming, purged: purged ?? [] };
}

