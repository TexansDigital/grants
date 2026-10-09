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

import type { Env, RequestContext, Session } from "../types";
import { nowIso, formatCalendarDay } from "./time";
import { sendEmail, transportFor } from "./email";
import {
  REPORT_REMINDER,
  MAX_REMINDER_NOTE,
  type ReminderLine,
} from "./emailTemplates";
import { daysUntil, GRANTEE_OWES } from "./reportDue";
import { AppError, logError } from "./errors";

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
  /**
   * Grantees a provider ACCEPTED a message for. Nothing else.
   *
   * This used to count a `suppressed` outcome too -- the status written when
   * there is no transport, meaning nothing left the building. That number
   * stamps `reminder_last_sent_at` and `reminder_count` on the report period,
   * and those render on the compliance desk as "2 · September 28": the
   * Foundation believing it had chased a nonprofit twice when it had chased
   * them never. The desk's whole job is to tell "they are ignoring us" from
   * "nobody has asked them", and that is the fact it got backwards.
   */
  granteesMailed: number;
  /** Message ROWS written, sent or not. Equals mailed + suppressed + failed. */
  messagesRecorded: number;
  /**
   * Recorded and not sent, because no provider is configured. The ordinary
   * state in preview and in tests; in production it means the key is gone.
   */
  suppressed: number;
  /**
   * A provider REFUSED the message -- a bad address, a bounce, an outage.
   * Counted and logged, where it used to fall through every branch silently:
   * not counted, not stamped, nothing written to the error log. A hard bounce
   * from a grantee's mail server was invisible to everybody.
   */
  failed: number;
  /**
   * Already written to today, so this run did nothing for them.
   *
   * `sendEmail` returns the EARLIER message's row when an idempotency key has
   * been used before -- and its status, which for a letter that went out this
   * morning is `sent`. So a second run read `status === 'sent'` and counted a
   * letter that it had not sent. Pressing Send twice reported "2 sent" with
   * nothing leaving the building, on the one screen whose job is to say who
   * has been contacted.
   *
   * The letters were never duplicated; the unique index saw to that. Only the
   * count was wrong, which is the more dangerous of the two, because a
   * duplicate letter is visible to somebody and a wrong count is not.
   */
  deduplicated: number;
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
  if (days >= 0)
    return (REMIND_BEFORE_DAYS as readonly number[]).includes(days);
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
export async function reportsOwed(
  db: D1Database,
  nowIsoStr: string,
): Promise<DueReport[]> {
  const owed = GRANTEE_OWES.map(() => "?").join(",");
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
            AND organization_id IN (${slice.map(() => "?").join(",")})
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
 * WHO TONIGHT'S RUN WOULD WRITE TO, WITHOUT WRITING TO ANYBODY.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A `dryRun` FLAG ON THE RUN. The run
 * below writes in six places: an email per grantee, an `email_messages` row per
 * attempt, three `error_log` codes, and the `reminder_count` stamp. A boolean
 * guarding six branches is one missed branch away from a "dry run" that mails
 * somebody, and the whole reason this exists is that nobody can afford to find
 * that out from a nonprofit's inbox. A function containing no call that writes
 * cannot write, and that property is checked by reading it rather than by
 * trusting a flag to be threaded correctly.
 *
 * It costs a second copy of the grouping logic. That is the right trade here.
 * The selection it must agree with -- `reportsOwed` and `isReminderDay` -- is
 * shared, so the two cannot disagree about WHO is due; what is duplicated is
 * only the grouping of due reports by organization.
 *
 * WHAT IT IS FOR. Reminders only ever ran from cron at 07:00, so the only way
 * to find out what they would do was to let them do it. This answers the
 * question an administrator has to be able to answer before any send: exactly
 * which addresses, at which organizations, for which reports. It is also the
 * safety mechanism for the real run below -- read the list, confirm it holds
 * nobody it should not, then confirm. Stronger than suppressing the mail,
 * which would prove the job ran and prove nothing about who it chose.
 */
export interface ReminderPlanOrg {
  organizationId: string;
  organizationName: string;
  /** Addresses that would be written to. Empty means nobody can be reached. */
  recipients: string[];
  reports: {
    reportPeriodId: string;
    label: string;
    programName: string;
    dueDate: string;
    /** Negative when the report is already late. */
    daysUntilDue: number;
    status: string;
  }[];
  /**
   * The actual letters, one per recipient address, as they would be sent.
   *
   * RENDERED BY THE SAME CALL THE SEND MAKES -- `REPORT_REMINDER.render` on
   * the same vars -- rather than reconstructed for display. A preview that
   * can diverge from the send is worse than no preview, because it is
   * believed.
   *
   * Empty for an organization with nobody to write to: there is no recipient,
   * so there is no letter to show.
   */
  letters: { to: string; subject: string; text: string }[];
}

export interface ReminderPlan {
  /** The instant the plan was computed for, so a stale panel is obvious. */
  now: string;
  /** Everything owed and actionable, whether or not today is a reminder day. */
  outstanding: number;
  /** Organizations that would be mailed, with the exact addresses. */
  wouldMail: ReminderPlanOrg[];
  /**
   * Due today, and nobody to write to. Surfaced here rather than logged,
   * because this function writes nothing -- including to `error_log`.
   */
  withNoContact: ReminderPlanOrg[];
  /** Letters that would leave the building: one per recipient address. */
  lettersWouldSend: number;
  /**
   * Whether a provider is configured at all. False means the real run would
   * record every message as `suppressed` and nothing would arrive -- which is
   * the normal state in preview and a missing key in production. Without this
   * an empty inbox after a confirmed run is unexplainable.
   */
  transportConfigured: boolean;
  /**
   * The note this plan was rendered with, echoed back so the screen and the
   * letters cannot disagree about what was previewed.
   */
  note: string;
  /**
   * A fingerprint of exactly what was shown: the note, every recipient
   * address, and the letter count.
   *
   * The confirm sends it back, the server recomputes it, and a mismatch
   * REFUSES the run. The existing count guard catches "thirteen became
   * fourteen"; this also catches "the same number of letters, to a different
   * address" and "somebody edited the note in another tab". What you read is
   * what leaves, or nothing does.
   */
  digest: string;
}

/**
 * The letter's variables, built ONCE and used by both the plan and the send.
 *
 * This function exists so the preview cannot drift from what is sent. Before
 * it, the run built these inline and the plan showed a summary; anybody adding
 * a field would have had to remember to add it twice, and the failure would
 * have been a preview that quietly lied.
 */
export function reminderVars(
  reports: DueReport[],
  nowStr: string,
  portalUrl: string,
  supportEmail: string,
  note: string,
): Parameters<typeof REPORT_REMINDER.render>[0] {
  return {
    organizationName: reports[0]!.organizationName,
    lines: reports.map((r) => ({
      label: r.label,
      programName: r.programName,
      /*
       * A calendar day, formatted in UTC. Rendering this in Central put
       * "October 21" in a letter about a report due the 22nd, in the same
       * sentence as a countdown that said 14 days. See src/lib/time.ts.
       */
      dueDisplay: formatCalendarDay(r.dueDate),
      daysUntilDue: daysUntil(r.dueDate, nowStr),
    })),
    portalUrl,
    supportEmail,
    note,
  };
}

/** A note, trimmed and capped the same way the template will cap it. */
export function cleanNote(note: string | null | undefined): string {
  return (note ?? "").trim().slice(0, MAX_REMINDER_NOTE);
}

/**
 * A fingerprint of what the screen showed.
 *
 * Over the NOTE, every RECIPIENT ADDRESS and the LETTER COUNT -- the three
 * things an administrator is being asked to approve. Not over the rendered
 * bodies, which contain a countdown that changes at midnight: a plan read at
 * 23:59 and confirmed at 00:01 would otherwise refuse for a reason nobody
 * could act on, and the count guard already catches a changed rung.
 *
 * Addresses are sorted so two runs over the same set agree.
 */
export async function reminderDigest(
  note: string,
  addresses: string[],
  letters: number,
): Promise<string> {
  const payload = JSON.stringify({
    note,
    to: [...addresses].sort(),
    letters,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function planReportReminders(
  env: Env,
  session: Session,
  opts: { now?: string; note?: string | null } = {},
): Promise<ReminderPlan> {
  if (session.role !== "admin") {
    throw new AppError("FORBIDDEN", "Only an administrator can do that.", {
      internalMessage: `reminder plan attempted by role ${session.role}`,
      severity: "warn",
    });
  }

  const nowStr = opts.now ?? nowIso();
  const note = cleanNote(opts.note);
  const portalUrl = `${(env.APPLICANT_BASE_URL ?? "").trim()}/reports`;
  const supportEmail =
    (env.EMAIL_REPLY_TO ?? "").trim() || "grants@houstontexansfoundation.org";
  const owed = await reportsOwed(env.DB, nowStr);
  const dueToday = owed.filter((r) => isReminderDay(r.dueDate, nowStr));

  const byOrg = await recipients(env.DB, [
    ...new Set(dueToday.map((r) => r.organizationId)),
  ]);

  const grouped = new Map<string, DueReport[]>();
  for (const r of dueToday) {
    const list = grouped.get(r.organizationId) ?? [];
    list.push(r);
    grouped.set(r.organizationId, list);
  }

  const wouldMail: ReminderPlanOrg[] = [];
  const withNoContact: ReminderPlanOrg[] = [];
  let lettersWouldSend = 0;

  for (const [organizationId, reports] of grouped) {
    const people = byOrg.get(organizationId) ?? [];
    const entry: ReminderPlanOrg = {
      organizationId,
      organizationName: reports[0]!.organizationName,
      recipients: people.map((p) => p.email),
      reports: reports.map((r) => ({
        reportPeriodId: r.reportPeriodId,
        label: r.label,
        programName: r.programName,
        dueDate: r.dueDate,
        daysUntilDue: daysUntil(r.dueDate, nowStr),
        status: r.status,
      })),
      /*
       * THE REAL LETTERS. Rendered here, by the same call the send makes, on
       * vars from the same builder -- so this is not a description of the
       * letter, it is the letter.
       */
      letters: people.map((person) => {
        const rendered = REPORT_REMINDER.render(
          reminderVars(reports, nowStr, portalUrl, supportEmail, note),
        );
        return { to: person.email, subject: rendered.subject, text: rendered.text };
      }),
    };
    if (people.length === 0) {
      withNoContact.push(entry);
    } else {
      // One letter per grantee ACCOUNT, matching the run: an organization with
      // two logins gets two, because either of them may be the one who files.
      lettersWouldSend += people.length;
      wouldMail.push(entry);
    }
  }

  const byName = (a: ReminderPlanOrg, b: ReminderPlanOrg) =>
    a.organizationName.localeCompare(b.organizationName);
  wouldMail.sort(byName);
  withNoContact.sort(byName);

  return {
    now: nowStr,
    outstanding: owed.length,
    wouldMail,
    withNoContact,
    lettersWouldSend,
    transportConfigured: transportFor(env) !== null,
    note,
    digest: await reminderDigest(
      note,
      wouldMail.flatMap((o) => o.recipients),
      lettersWouldSend,
    ),
  };
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
  /*
   * The fetcher the provider transport uses, injectable for tests.
   *
   * Without this there was no way to exercise a SENT reminder at all: the
   * suite has no RESEND_API_KEY, so `transportFor` returned null and every
   * message was suppressed -- and the tests then asserted that a suppressed
   * message counted as mailed and stamped the report period. They were green,
   * and they were pinning the bug. The same reasoning as sendEmail's required
   * `transport` argument, which exists so no production path is untestable.
   */
  fetcher: typeof fetch = fetch,
  /*
   * The Foundation's note for THIS run, or none.
   *
   * Defaulted to empty so the NIGHTLY CRON carries no note: a note is written
   * for a particular round by a particular person, and one that silently rode
   * along with every later automatic send would be worse than no note at all.
   * Only the confirmed manual send passes one.
   */
  note = "",
): Promise<ReminderRun> {
  const nowStr = now.toISOString();
  const owed = await reportsOwed(env.DB, nowStr);

  const dueToday = owed.filter((r) => isReminderDay(r.dueDate, nowStr));
  if (dueToday.length === 0) {
    return {
      outstanding: owed.length,
      granteesMailed: 0,
      messagesRecorded: 0,
      suppressed: 0,
      deduplicated: 0,
      failed: 0,
      withNoContact: 0,
    };
  }

  const byOrg = await recipients(env.DB, [
    ...new Set(dueToday.map((r) => r.organizationId)),
  ]);

  // A date, not a moment. A due date is a day, and "due 31 March at 11:04 PM
  // CDT" invites somebody to believe the minute matters.
  const day = nowStr.slice(0, 10);
  const portalUrl = `${(env.APPLICANT_BASE_URL ?? "").trim()}/reports`;
  const supportEmail =
    (env.EMAIL_REPLY_TO ?? "").trim() || "grants@houstontexansfoundation.org";
  const transport = transportFor(env, fetcher);

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
  let suppressed = 0;
  let deduplicated = 0;
  let failed = 0;
  let withNoContact = 0;
  const remindedPeriods: string[] = [];

  for (const [organizationId, reports] of byOrgReports) {
    /* What THIS organization achieved, as against the run's running total. */
    let mailedHere = 0;
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
        severity: "warn",
        code: "REPORT_REMINDER_NO_CONTACT",
        message:
          "a report is due and the organization has no active grantee account",
        context: {
          organization_id: organizationId,
          organization: reports[0]?.organizationName ?? null,
          report_periods: reports.length,
        },
      });
      continue;
    }

    /*
     * BUILT BY THE SAME FUNCTION THE PREVIEW USES, so what an administrator
     * reads on the Reports screen and what a grantee receives cannot drift
     * apart. Before that shared builder these were two copies of the same
     * mapping, and a field added to one would silently have been missing from
     * the other.
     */
    const vars = reminderVars(reports, nowStr, portalUrl, supportEmail, note);
    const lines: ReminderLine[] = vars.lines;

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
            vars,
            context: {
              day,
              organization_id: organizationId,
              report_periods: reports.length,
            },
          },
          transport,
        );
        /*
         * DEDUPLICATED FIRST, before the status branches, because a
         * deduplicated outcome carries the earlier message's status and every
         * branch below would read it as something this run achieved. Nothing
         * was written, nothing was sent, and the period was already stamped by
         * the run that did send -- so this must not reach `mailedHere` either,
         * or one letter would raise `reminder_count` twice.
         */
        if (outcome.deduplicated) {
          deduplicated += 1;
        } else {
          messagesRecorded += 1;
          if (outcome.status === "sent") {
            granteesMailed += 1;
            mailedHere += 1;
          } else if (outcome.status === "suppressed") {
            suppressed += 1;
          } else if (outcome.status === "failed") {
            failed += 1;
            /*
             * LOGGED, because nothing else will. sendEmail RETURNS a failure
             * rather than throwing, so the catch below never fired for this and
             * the grantee simply never heard from us. The report then goes
             * overdue, tomorrow's reminder fails the same way, and the desk
             * shows a red row nobody caused.
             */
            await logError(env, ctx, {
              severity: "error",
              code: "REPORT_REMINDER_NOT_DELIVERED",
              message:
                "the provider refused a reminder; this grantee was not reached",
              context: {
                organization_id: organizationId,
                organization: reports[0]?.organizationName ?? null,
                user_id: person.id,
                report_periods: reports.length,
              },
            });
          }
        }
      } catch (err) {
        await logError(env, ctx, {
          severity: "error",
          code: "REPORT_REMINDER_FAILED",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
          context: { organization_id: organizationId, user_id: person.id },
        });
      }
    }

    /*
     * PER-ORGANIZATION, not a running total. `granteesMailed` accumulates
     * across the whole run, so testing it here marked every later
     * organization as reminded the moment any earlier one was -- including
     * organizations whose own send was suppressed or refused. Counting what
     * this organization achieved is the only thing that can gate its stamp.
     */
    if (mailedHere > 0)
      remindedPeriods.push(...reports.map((r) => r.reportPeriodId));
  }

  /*
   * STAMPED ONLY FOR MESSAGES THAT WERE ACTUALLY SENT, and the distinction is
   * the point of this whole change. `reminder_last_sent_at` and
   * `reminder_count` are a claim about the outside world, rendered to staff as
   * "we chased them, on this date". A row written and not delivered is not
   * that claim.
   *
   * Deliberately NOT the same rule as the retention notice in retention.ts,
   * which does count a suppressed message: that one stamps `noticed_at` as its
   * own bookkeeping -- "this file has been named in a notice that was due" --
   * and nothing renders it as a statement about anybody having been told.
   */
  if (remindedPeriods.length > 0)
    await stampReminded(env.DB, remindedPeriods, nowStr);

  return {
    outstanding: owed.length,
    granteesMailed,
    messagesRecorded,
    suppressed,
    deduplicated,
    failed,
    withNoContact,
  };
}

/**
 * An administrator running tonight's reminders now, on purpose.
 *
 * WHY IT TAKES A COUNT. The caller must pass the number of letters it was
 * shown by `planReportReminders`, and a mismatch refuses the whole run. The
 * failure this prevents is specific and entirely plausible: an administrator
 * reads a plan that says one letter to a test mailbox, is interrupted, and
 * confirms twenty minutes later -- by which time an import, another admin, or
 * the passing of midnight into a 14-day rung has made it thirteen letters to
 * thirteen nonprofits. The screen said one. The confirm has to mean one.
 *
 * It also makes the obvious mistake impossible: a bare POST to this path, from
 * a script or a curl line, carries no count and is refused.
 *
 * NOT AN IDEMPOTENCY MECHANISM. `email_messages` is, as everywhere else in
 * this system: one letter per grantee account per day, enforced by a unique
 * index. Running this twice in a day does not mail anybody twice. This guards
 * against sending the WRONG SIZE of thing, which an idempotency key cannot
 * see.
 */
export interface ConfirmedReminderRun extends ReminderRun {
  /** The plan that was actually executed, for the record and the screen. */
  plan: ReminderPlan;
}

export async function runRemindersNow(
  env: Env,
  ctx: RequestContext,
  session: Session,
  opts: {
    expectLetters: number;
    now?: string;
    fetcher?: typeof fetch;
    /** The Foundation's note, exactly as it was previewed. */
    note?: string | null;
    /** The plan's digest, as the screen was shown it. */
    expectDigest?: string;
  },
): Promise<ConfirmedReminderRun> {
  // planReportReminders refuses a non-admin, which covers this path too. The
  // check is repeated rather than inherited because this is the writing path,
  // and a future refactor that stops calling the plan first must not quietly
  // open it.
  if (session.role !== "admin") {
    throw new AppError("FORBIDDEN", "Only an administrator can do that.", {
      internalMessage: `reminder run attempted by role ${session.role}`,
      severity: "warn",
    });
  }

  if (!Number.isInteger(opts.expectLetters) || opts.expectLetters < 0) {
    throw new AppError("VALIDATION_FAILED", "Review the plan before sending.", {
      internalMessage: `runRemindersNow called with expectLetters ${String(opts.expectLetters)}`,
      severity: "warn",
    });
  }

  const nowStr = opts.now ?? nowIso();
  const note = cleanNote(opts.note);
  const plan = await planReportReminders(env, session, { now: nowStr, note });

  if (plan.lettersWouldSend !== opts.expectLetters) {
    throw new AppError(
      "VALIDATION_FAILED",
      `This would now send ${plan.lettersWouldSend} ${
        plan.lettersWouldSend === 1 ? "letter" : "letters"
      }, not ${opts.expectLetters}. Nothing was sent. Review the plan again.`,
      {
        internalMessage:
          `reminder run refused: plan says ${plan.lettersWouldSend}, ` +
          `caller expected ${opts.expectLetters}`,
        severity: "warn",
      },
    );
  }

  /*
   * THE DIGEST, which is the count guard's stronger sibling.
   *
   * The count catches "thirteen became fourteen". It does NOT catch the same
   * number of letters going somewhere else -- a grantee account deactivated
   * and another added between reading and confirming -- nor a note edited in
   * a second tab after this one rendered. The digest covers the note, every
   * address and the count, so what was read is what leaves, or nothing does.
   *
   * Optional, so an older client that sends no digest still gets the count
   * guard rather than a refusal it cannot explain. A client that DOES send
   * one is held to it.
   */
  if (opts.expectDigest !== undefined && opts.expectDigest !== plan.digest) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Something changed since you read the plan \u2014 the recipients or the note " +
        "are not what was on screen. Nothing was sent. Read the plan again.",
      {
        internalMessage:
          `reminder run refused on digest: plan ${plan.digest}, ` +
          `caller ${opts.expectDigest}`,
        severity: "warn",
      },
    );
  }

  /*
   * NOTHING TO DO IS NOT A FAILURE, and it is the state production is in
   * before any obligation exists. Returning the zeroed run keeps the screen
   * able to say "nobody was due" rather than showing an error.
   */
  const run = await runReportReminders(
    env,
    ctx,
    new Date(nowStr),
    opts.fetcher ?? fetch,
    note,
  );
  return { ...run, plan };
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
async function stampReminded(
  db: D1Database,
  ids: string[],
  nowIsoStr: string,
): Promise<void> {
  const CHUNK = 50;
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    await db
      .prepare(
        `UPDATE report_periods
            SET reminder_last_sent_at = ?, reminder_count = reminder_count + 1
          WHERE id IN (${slice.map(() => "?").join(",")}) AND deleted_at IS NULL`,
      )
      .bind(nowIsoStr, ...slice)
      .run();
  }
}
