/**
 * Telling a grantee their report is due.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT ELOQUA. The reporting portal has been
 * finished for a while: a grantee signs in by magic link, sees what is due, and
 * files it in three clicks. Nothing anywhere told them it existed. The plan put
 * reminders on Eloqua -- correctly, since batch latency does not matter for a
 * nudge -- but that needs a form endpoint, a site id, generated field names, a
 * shared list and an email group from a marketing admin, none of which exist
 * yet. Until they do, the portal is a page nobody is sent to, and a report
 * nobody is asked for is a report nobody files. The compliance policy then
 * blocks that organization's next application over a silence the Foundation
 * caused.
 *
 * So the reminder goes through Resend, on the transactional domain that already
 * carries the sign-in link. The volume settles it: 100 to 300 grantees a cycle
 * on a ladder of a few sends each is far inside the free tier. The Eloqua path
 * is unchanged and still the right home for this when somebody owns it there;
 * this is what runs in the meantime, and it is deliberately easy to turn off.
 *
 * THE LETTER CARRIES NO SIGN-IN TOKEN. A reminder is a bulk send: it goes to a
 * list, gets forwarded inside an organization, and sits in mailboxes for
 * months. A token in it would be a credential with all of those properties. The
 * letter points at the page; the page mints a link when somebody asks.
 *
 * WHAT MAKES IT NOT SPAM. Three things, and each is a decision rather than a
 * default:
 *
 *   1. A LADDER, NOT A DRIP. Fixed points before the date and a weekly nudge
 *      after it, with an end. Retention mails daily inside its last week
 *      because a file is about to be destroyed forever; a report is not
 *      destroyed, and daily mail about it teaches the recipient to filter the
 *      sender -- after which the one that matters is filtered too.
 *   2. ONE LETTER PER GRANTEE, listing every report they owe. Three emails
 *      arriving together is the same lesson taught faster.
 *   3. IT STOPS. After the cap below an overdue report is a phone call, not
 *      another email, and the compliance desk is where that conversation
 *      starts.
 */

import type { Env, RequestContext } from '../types';
import { nowIso, formatDayInZone } from './time';
import { sendEmail, transportFor } from './email';
import { REPORT_REMINDER, type ReminderLine } from './emailTemplates';
import { daysUntil, GRANTEE_OWES } from './reportDue';
import { logError } from './errors';

/**
 * The ladder, in days before the due date.
 *
 * Two weeks is enough to gather figures from a programme team; three days is
 * the one that actually works; the day itself is the last chance to file on
 * time. Nothing between, because a reminder that arrives while the last one is
 * still unactioned is noise.
 */
export const REMIND_BEFORE_DAYS = [14, 3, 0] as const;

/** Once a week after the date, on the same weekday the first one landed. */
export const OVERDUE_EVERY_DAYS = 7;

/**
 * Stop after roughly three months of weekly nudges.
 *
 * Not a guess at politeness. Past this, twelve unanswered emails mean the
 * address is wrong, the person has left, or the organization has decided not to
 * report -- and a thirteenth email tests none of those. The compliance desk
 * still shows the row, and the count of reminders sent is on it, so the next
 * step is a person.
 */
export const OVERDUE_STOP_AFTER_DAYS = 91;

export interface DueReport {
  reportPeriodId: string;
  awardId: string;
  organizationId: string;
  organizationName: string;
  programName: string;
  label: string;
  dueDate: string;
  status: string;
  opensAt: string | null;
}

export interface ReminderRun {
  /** Reports the grantee still owes and can act on today. */
  outstanding: number;
  /** Grantees who reached a point on the ladder today. */
  granteesMailed: number;
  /** Message ROWS written. A suppressed send is recorded, not sent. */
  messagesRecorded: number;
  /** Report periods with nobody to write to. The reason to look at the desk. */
  withNoContact: number;
}

/**
 * Is today a rung on the ladder for this report?
 *
 * PURE, and takes the day rather than reading a clock, so every branch is
 * testable without waiting or mocking time.
 */
export function isReminderDay(dueIso: string, nowIsoStr: string): boolean {
  const days = daysUntil(dueIso, nowIsoStr);
  if (days >= 0) return (REMIND_BEFORE_DAYS as readonly number[]).includes(days);
  const late = -days;
  if (late > OVERDUE_STOP_AFTER_DAYS) return false;
  /*
   * `late % 7 === 0` and not "every seventh run": a cron that misses a night
   * would otherwise shift the whole schedule for that grantee, and two
   * grantees would drift onto different weekdays for no reason anybody could
   * explain. Anchored to the due date, a missed night costs that week's
   * reminder and nothing else.
   */
  return late % OVERDUE_EVERY_DAYS === 0;
}

/**
 * Everything a grantee still owes and could file today.
 *
 * THREE EXCLUSIONS, each of which would otherwise produce a letter asking
 * somebody to do something they cannot:
 *
 *   - A CANCELLED AWARD. Its report periods survive the cancellation, go
 *     overdue, and would be chased forever for a grant nobody took. The same
 *     defect the dashboard's compliance figure had.
 *   - A PERIOD NOT YET OPEN. `scheduled` with `opens_at` in the future is a
 *     report the portal will not let them file. "Please file this" pointing at
 *     a page with no button is worse than silence.
 *   - A PERIOD WITH NO FORM. Nothing to fill in yet; that is the Foundation's
 *     work, not the grantee's.
 */
export async function reportsOwed(db: D1Database, nowIsoStr: string): Promise<DueReport[]> {
  const owed = GRANTEE_OWES.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT rp.id AS reportPeriodId, rp.award_id AS awardId, rp.label,
              rp.due_date AS dueDate, rp.status, rp.opens_at AS opensAt,
              w.organization_id AS organizationId,
              o.legal_name AS organizationName,
              p.name AS programName
         FROM report_periods rp
         JOIN awards w        ON w.id = rp.award_id AND w.deleted_at IS NULL
                             AND w.status <> 'cancelled'
         JOIN organizations o ON o.id = w.organization_id AND o.deleted_at IS NULL
         JOIN programs p      ON p.id = w.program_id AND p.deleted_at IS NULL
        WHERE rp.deleted_at IS NULL
          AND rp.status IN (${owed})
          AND rp.form_definition_id IS NOT NULL
          AND (rp.opens_at IS NULL OR rp.opens_at <= ?)
        ORDER BY rp.due_date, o.legal_name`,
    )
    .bind(...GRANTEE_OWES, nowIsoStr)
    .all<DueReport>();
  return results ?? [];
}

/** Who to write to for one organization: its active grantee accounts. */
async function recipients(
  db: D1Database,
  organizationIds: string[],
): Promise<Map<string, { id: string; email: string }[]>> {
  const byOrg = new Map<string, { id: string; email: string }[]>();
  const CHUNK = 50;
  for (let i = 0; i < organizationIds.length; i += CHUNK) {
    const slice = organizationIds.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT id, email, organization_id AS organizationId FROM users
          WHERE role = 'grantee' AND is_active = 1 AND deleted_at IS NULL
            AND organization_id IN (${slice.map(() => '?').join(',')})
          ORDER BY email`,
      )
      .bind(...slice)
      .all<{ id: string; email: string; organizationId: string }>();
    for (const r of results ?? []) {
      const list = byOrg.get(r.organizationId) ?? [];
      list.push({ id: r.id, email: r.email });
      byOrg.set(r.organizationId, list);
    }
  }
  return byOrg;
}

/**
 * The nightly run.
 *
 * ONE DIGEST PER GRANTEE ACCOUNT, not per organization, because the account is
 * what an idempotency key can be built from and what a person actually reads.
 * An organization with two grantee logins gets two letters, which is correct:
 * they are two people, and each one may be the one who files.
 *
 * A FAILURE FOR ONE GRANTEE DOES NOT STOP THE REST. The alternative is that one
 * bad address -- a nonprofit's shared mailbox that bounced, a domain that
 * lapsed -- silences every other reminder that night, and the symptom is
 * indistinguishable from a quiet portfolio.
 */
export async function runReportReminders(
  env: Env,
  ctx: RequestContext,
  now: Date = new Date(),
): Promise<ReminderRun> {
  const nowStr = now.toISOString();
  const owed = await reportsOwed(env.DB, nowStr);

  const dueToday = owed.filter((r) => isReminderDay(r.dueDate, nowStr));
  if (dueToday.length === 0) {
    return {
      outstanding: owed.length,
      granteesMailed: 0,
      messagesRecorded: 0,
      withNoContact: 0,
    };
  }

  const byOrg = await recipients(env.DB, [...new Set(dueToday.map((r) => r.organizationId))]);

  // A date, not a moment. A due date is a day, and "due 31 March at 11:04 PM
  // CDT" invites somebody to believe the minute matters.
  const day = nowStr.slice(0, 10);
  const portalUrl = `${(env.APPLICANT_BASE_URL ?? '').trim()}/reports`;
  const supportEmail = (env.EMAIL_REPLY_TO ?? '').trim() || 'grants@houstontexansfoundation.org';
  const transport = transportFor(env);

  // Group the reports by organization once, so each grantee's letter lists
  // everything their organization owes today rather than one report each.
  const byOrgReports = new Map<string, DueReport[]>();
  for (const r of dueToday) {
    const list = byOrgReports.get(r.organizationId) ?? [];
    list.push(r);
    byOrgReports.set(r.organizationId, list);
  }

  let granteesMailed = 0;
  let messagesRecorded = 0;
  let withNoContact = 0;
  const remindedPeriods: string[] = [];

  for (const [organizationId, reports] of byOrgReports) {
    const people = byOrg.get(organizationId) ?? [];
    if (people.length === 0) {
      /*
       * AN AWARD WITH NOBODY TO WRITE TO. Logged rather than skipped silently:
       * it means a grantee account was never created or has been deactivated,
       * and the compliance desk will show the report going overdue with no
       * explanation. This is the line that explains it.
       */
      withNoContact += reports.length;
      await logError(env, ctx, {
        severity: 'warn',
        code: 'REPORT_REMINDER_NO_CONTACT',
        message: 'a report is due and the organization has no active grantee account',
        context: {
          organization_id: organizationId,
          organization: reports[0]?.organizationName ?? null,
          report_periods: reports.length,
        },
      });
      continue;
    }

    const lines: ReminderLine[] = reports.map((r) => ({
      label: r.label,
      programName: r.programName,
      dueDisplay: formatDayInZone(r.dueDate, env.DISPLAY_TIMEZONE),
      daysUntilDue: daysUntil(r.dueDate, nowStr),
    }));

    for (const person of people) {
      try {
        const outcome = await sendEmail(
          env,
          ctx,
          {
            template: REPORT_REMINDER,
            to: person.email,
            // Per account, per day. A cron that fires twice -- a retry, an
            // overlapping run, a manual trigger -- produces one letter, and the
            // guarantee is the unique index rather than an assumption about
            // how often the scheduler runs.
            idempotencyKey: `report_reminder:${person.id}:${day}`,
            vars: {
              organizationName: reports[0]!.organizationName,
              lines,
              portalUrl,
              supportEmail,
            },
            context: {
              day,
              organization_id: organizationId,
              report_periods: reports.length,
            },
          },
          transport,
        );
        if (outcome.status === 'sent' || outcome.status === 'suppressed') {
          messagesRecorded += 1;
          granteesMailed += 1;
        }
      } catch (err) {
        await logError(env, ctx, {
          severity: 'error',
          code: 'REPORT_REMINDER_FAILED',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
          context: { organization_id: organizationId, user_id: person.id },
        });
      }
    }

    if (granteesMailed > 0) remindedPeriods.push(...reports.map((r) => r.reportPeriodId));
  }

  if (remindedPeriods.length > 0) await stampReminded(env.DB, remindedPeriods, nowStr);

  return {
    outstanding: owed.length,
    granteesMailed,
    messagesRecorded,
    withNoContact,
  };
}

/**
 * Write down that these reports were chased, and how many times.
 *
 * NOT THE IDEMPOTENCY MECHANISM -- `email_messages` is, as it is for every send
 * in this system. This answers the question a program officer asks before
 * picking up the phone: "how many times have we asked?" Without it an overdue
 * row on the compliance desk is ambiguous between a nonprofit ignoring us and a
 * nonprofit nobody contacted, and those call for opposite conversations.
 *
 * Chunked, because a cycle's worth of reports can exceed a comfortable number
 * of bound parameters in one statement.
 */
async function stampReminded(db: D1Database, ids: string[], nowIsoStr: string): Promise<void> {
  const CHUNK = 50;
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    await db
      .prepare(
        `UPDATE report_periods
            SET reminder_last_sent_at = ?, reminder_count = reminder_count + 1
          WHERE id IN (${slice.map(() => '?').join(',')}) AND deleted_at IS NULL`,
      )
      .bind(nowIsoStr, ...slice)
      .run();
  }
}
