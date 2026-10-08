/**
 * Telling a grantee their report is due.
 *
 * WHAT THESE PROTECT. This is the only job in the system that writes to a few
 * hundred people who did not ask for the message, and every way it can be
 * wrong is a way that costs the Foundation something real:
 *
 *   - Chasing a grant nobody took. A refused award keeps its report periods,
 *     they go overdue, and without a status filter this job would mail that
 *     nonprofit every week for three months about a grant they declined.
 *   - Asking for something that cannot be filed. A period not yet open, or
 *     with no form on it, sends somebody to a page with no button.
 *   - Mailing daily. The recipient filters the sender, and the message that
 *     matters is then filtered too.
 *   - Never stopping. Twelve unanswered emails mean the address is wrong; a
 *     thirteenth tests nothing.
 *   - Carrying a sign-in token. A reminder is forwarded and kept; a
 *     credential with those properties is one somebody else can use.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom, forceDueDate,
} from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision } from '../src/lib/awards';
import { buildReportForm } from '../src/lib/reportForm';
import {
  runReportReminders, isReminderDay, reportsOwed, planReportReminders, runRemindersNow,
  REMIND_BEFORE_DAYS, OVERDUE_EVERY_DAYS, OVERDUE_STOP_AFTER_DAYS,
} from '../src/lib/reportReminders';
import { REPORT_REMINDER } from '../src/lib/emailTemplates';
import type { Env, Session } from '../src/types';

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/**
 * A provider that accepts, refuses, or is absent.
 *
 * WHY THIS HAD TO EXIST. The suite has no RESEND_API_KEY, so every message was
 * `suppressed` -- nothing left the building -- and the tests asserted that a
 * suppressed message counted as mailed and stamped the report period. Green,
 * and pinning the bug. There was no way to write a test for a reminder that
 * actually went, because there was no way to make one go.
 */
const accepts: typeof fetch = async () =>
  new Response(JSON.stringify({ id: 'msg_test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const refuses: typeof fetch = async () =>
  new Response(JSON.stringify({ message: 'mailbox unavailable' }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });

/** An env with a provider configured. The key is never used; `accepts` is. */
const liveEnv = (over: Partial<Env> = {}): Env =>
  mailEnv({ RESEND_API_KEY: 'test-key-not-a-real-one', ...over });

const mailEnv = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  DISPLAY_TIMEZONE: 'America/Chicago',
  APPLICANT_BASE_URL: 'https://apply.example.org',
  EMAIL_FROM: 'Houston Texans Foundation <grants@example.org>',
  EMAIL_REPLY_TO: 'grants@example.org',
  ...over,
});

let n = 0;
let admin: Session;

beforeEach(async () => {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(id, `rem-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

/**
 * A grantee holding one award with one report period due in `dueInDays`.
 *
 * The period is created directly rather than generated from the term, because
 * these tests are about WHEN a reminder goes out and need the due date under
 * their control rather than derived from a schedule with its own rules.
 */
async function granteeOwing(opts: {
  dueInDays: number;
  status?: string;
  opensInDays?: number | null;
  withForm?: boolean;
  withContact?: boolean;
  cancelled?: boolean;
}) {
  const {
    dueInDays, status = 'open', opensInDays = -1,
    withForm = true, withContact = true, cancelled = false,
  } = opts;

  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `rem-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Harbour ${n}`, String(970000000 + n), now, now)
    .run();

  let granteeEmail: string | null = null;
  if (withContact) {
    granteeEmail = `grantee-${crypto.randomUUID().slice(0, 8)}@example.org`;
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
      )
      .bind(newId(), granteeEmail, orgId, now, now)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(applicationId, cycleId, orgId, now, `Project ${n}`, now, now,
      p.formDefinitionIds.application!)
    .run();
  await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });
  const award = await createAwardFromDecision(db, ctx(), admin, applicationId, {
    awardedAmountCents: 2_500_000,
    termStart: iso(-30 * DAY),
    termEnd: iso(335 * DAY),
  });

  if (cancelled) {
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`)
      .bind(award.awardId).run();
  }

  // The seed builds no report form; a program gets one when an admin asks for
  // it. Without one there is nothing for a grantee to file, which is its own
  // test below.
  let formId: string | null = null;
  if (withForm) {
    const form = await buildReportForm(db, ctx(), { programId: p.programId });
    await db
      .prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
      .bind(now, form.formDefinitionId)
      .run();
    formId = form.formDefinitionId;
  }

  const periodId = newId();
  await db
    .prepare(
      `INSERT INTO report_periods (id, award_id, label, period_type, due_date, opens_at,
         status, form_definition_id, created_at, updated_at)
       VALUES (?,?, 'Final report', 'final', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      periodId, award.awardId, iso(dueInDays * DAY),
      opensInDays === null ? null : iso(opensInDays * DAY),
      status, formId, now, now,
    )
    .run();

  return { orgId, awardId: award.awardId, periodId, granteeEmail, programId: p.programId };
}

const mailCount = async (to: string) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE to_email = ?`)
    .bind(to)
    .first<{ n: number }>())!.n;

// ---------------------------------------------------------------------------

describe('when a reminder goes out', () => {
  const now = '2026-06-01T07:00:00.000Z';
  const due = (days: number) =>
    new Date(Date.parse(now) + days * DAY).toISOString();

  it('sends on each rung of the ladder and nowhere between', async () => {
    /*
     * Two weeks is enough to gather figures from a programme team; three days
     * is the one that actually works; the day itself is the last chance to
     * file on time. Nothing between, because a reminder arriving while the
     * last one is still unactioned is noise.
     */
    for (const d of REMIND_BEFORE_DAYS) {
      expect(isReminderDay(due(d), now), `${d} days before`).toBe(true);
    }
    for (const d of [30, 21, 13, 10, 7, 5, 4, 2, 1]) {
      expect(isReminderDay(due(d), now), `${d} days before`).toBe(false);
    }
  });

  it('then weekly once it is overdue, anchored to the due date', async () => {
    /*
     * Anchored, not "every seventh run". A cron that misses a night would
     * otherwise shift the whole schedule for that grantee, and two grantees
     * would drift onto different weekdays for no reason anybody could
     * explain. Anchored, a missed night costs that week and nothing else.
     */
    for (const late of [OVERDUE_EVERY_DAYS, 14, 21, 70]) {
      expect(isReminderDay(due(-late), now), `${late} days late`).toBe(true);
    }
    for (const late of [1, 3, 6, 8, 13]) {
      expect(isReminderDay(due(-late), now), `${late} days late`).toBe(false);
    }
  });

  it('stops, because a thirteenth email tests nothing the twelfth did not', async () => {
    expect(isReminderDay(due(-OVERDUE_STOP_AFTER_DAYS), now)).toBe(true);
    expect(isReminderDay(due(-(OVERDUE_STOP_AFTER_DAYS + OVERDUE_EVERY_DAYS)), now)).toBe(false);
    expect(isReminderDay(due(-365), now)).toBe(false);
  });
});

describe('who is chased, and who is not', () => {
  it('writes to the grantee when a report is due in three days', async () => {
    const g = await granteeOwing({ dueInDays: 3 });
    const run = await runReportReminders(liveEnv(), ctx(), new Date(), accepts);
    expect(run.granteesMailed).toBe(1);
    expect(run.suppressed).toBe(0);
    expect(run.failed).toBe(0);
    expect(await mailCount(g.granteeEmail!)).toBe(1);

    const row = await db
      .prepare(
        `SELECT subject, template_key AS key FROM email_messages WHERE to_email = ?`,
      )
      .bind(g.granteeEmail!)
      .first<{ subject: string; key: string }>();
    expect(row?.key).toBe('report_reminder');
    expect(row?.subject).toMatch(/due/i);
  });

  it('never chases a grant the organization refused', async () => {
    /*
     * THE BUG THIS PREVENTS. A refused award keeps the report periods
     * generated from its term. They go overdue like any other, and without the
     * status filter this job would mail that nonprofit every week for three
     * months about a grant they declined -- which is the single most
     * embarrassing message this system could send.
     */
    const g = await granteeOwing({ dueInDays: 3, cancelled: true });
    const run = await runReportReminders(mailEnv(), ctx());
    expect(run.granteesMailed).toBe(0);
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });

  it('does not ask for a report that is not open yet', async () => {
    // "Please file this" pointing at a page with no button is worse than
    // silence: it teaches the recipient that the mail is wrong.
    const g = await granteeOwing({ dueInDays: 3, status: 'scheduled', opensInDays: 2 });
    expect((await reportsOwed(db, nowIso())).length).toBe(0);
    await runReportReminders(mailEnv(), ctx());
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });

  it('does not ask for a report with no form on it, which is our work not theirs', async () => {
    const g = await granteeOwing({ dueInDays: 3, withForm: false });
    await runReportReminders(mailEnv(), ctx());
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });

  it('does not chase a report that has already been filed', async () => {
    const g = await granteeOwing({ dueInDays: 3, status: 'submitted' });
    await runReportReminders(mailEnv(), ctx());
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });

  it('records an award with nobody to write to, rather than skipping it silently', async () => {
    /*
     * A grantee account that was never created or has been deactivated. The
     * compliance desk would otherwise show the report going overdue with no
     * explanation at all, and the explanation is that nobody could be told.
     */
    const g = await granteeOwing({ dueInDays: 3, withContact: false });
    const run = await runReportReminders(mailEnv(), ctx());
    expect(run.withNoContact).toBe(1);
    expect(run.granteesMailed).toBe(0);

    const logged = await db
      .prepare(`SELECT COUNT(*) AS n FROM error_log WHERE code = 'REPORT_REMINDER_NO_CONTACT'`)
      .first<{ n: number }>();
    expect(logged?.n).toBe(1);
    expect(g.periodId).toBeTruthy();
  });
});

describe('what the letter is, and is not', () => {
  it('carries no sign-in token, because a reminder is forwarded and kept', async () => {
    /*
     * THE SECURITY DESIGN OF THIS MESSAGE, not a detail. A reminder goes to a
     * list, gets forwarded inside an organization, and sits in mailboxes for
     * months. A sign-in token in it would be a credential with all of those
     * properties.
     */
    const g = await granteeOwing({ dueInDays: 3 });
    await runReportReminders(mailEnv(), ctx());

    const rendered = REPORT_REMINDER.render({
      organizationName: 'Invented Harbour',
      lines: [{
        label: 'Final report', programName: 'Inspire Change',
        dueDisplay: 'March 31, 2027', daysUntilDue: 3,
      }],
      portalUrl: 'https://apply.example.org/reports',
      supportEmail: 'grants@example.org',
    });
    const body = `${rendered.text}\n${rendered.html}`;
    expect(body).toContain('https://apply.example.org/reports');
    for (const shape of ['token=', '/sign-in/', 'sign-in?']) {
      expect(body, `letter must not carry ${shape}`).not.toContain(shape);
    }
    expect(body).toMatch(/no password/i);
    expect(g.granteeEmail).toBeTruthy();
  });

  it('keeps amounts and report content out of it', async () => {
    // A reminder is an envelope. It names the organization, the report and the
    // date, and nothing a forwarded copy should not carry.
    const rendered = REPORT_REMINDER.render({
      organizationName: 'Invented Harbour',
      lines: [{
        label: 'Final report', programName: 'Inspire Change',
        dueDisplay: 'March 31, 2027', daysUntilDue: -14,
      }],
      portalUrl: 'https://apply.example.org/reports',
      supportEmail: 'grants@example.org',
    });
    expect(`${rendered.text}${rendered.html}`).not.toMatch(/\$[\d,]/);
    expect(rendered.subject).toMatch(/overdue/i);
    expect(rendered.text).toMatch(/hold up a new application/i);
  });

  it('sends one letter listing both reports, not one letter each', async () => {
    /*
     * Three emails arriving together is how a sender teaches a recipient to
     * filter them, after which the one that matters is filtered too.
     */
    const g = await granteeOwing({ dueInDays: 3 });
    // A second award for the same organization, with its own report due today.
    const now = nowIso();
    const otherAward = newId();
    // `source_system` on the insert, not afterwards: an award with neither an
    // application nor a source cannot be traced to anything, and the schema
    // refuses it rather than letting it exist for one statement.
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id,
           awarded_amount_cents, awarded_at, status, source_system, source_reference,
           created_at, updated_at)
         SELECT ?, NULL, ?, program_id, 100000, ?, 'active', 'manual', ?, ?, ?
           FROM awards WHERE id = ?`,
      )
      .bind(otherAward, g.orgId, now, `rem-${otherAward.slice(0, 8)}`, now, now, g.awardId)
      .run();
    const formId = (await db
      .prepare(`SELECT form_definition_id AS id FROM report_periods WHERE id = ?`)
      .bind(g.periodId)
      .first<{ id: string }>())!.id;
    await db
      .prepare(
        `INSERT INTO report_periods (id, award_id, label, period_type, due_date, opens_at,
           status, form_definition_id, created_at, updated_at)
         VALUES (?,?, 'Year 1 report', 'interim', ?, ?, 'open', ?, ?, ?)`,
      )
      .bind(newId(), otherAward, iso(3 * DAY), iso(-DAY), formId, now, now)
      .run();

    const run = await runReportReminders(liveEnv(), ctx(), new Date(), accepts);
    expect(run.granteesMailed).toBe(1);
    expect(await mailCount(g.granteeEmail!)).toBe(1);

    const row = await db
      .prepare(`SELECT context_json AS ctx FROM email_messages WHERE to_email = ?`)
      .bind(g.granteeEmail!)
      .first<{ ctx: string }>();
    expect(JSON.parse(row!.ctx).report_periods).toBe(2);
  });
});

describe('running it twice', () => {
  it('writes one message however often the cron fires', async () => {
    // The guarantee is the unique index on the idempotency key, not an
    // assumption about how often the scheduler runs.
    const g = await granteeOwing({ dueInDays: 3 });
    await runReportReminders(mailEnv(), ctx());
    await runReportReminders(mailEnv(), ctx());
    expect(await mailCount(g.granteeEmail!)).toBe(1);
  });

  it('does not report a letter as sent when an earlier run already sent it', async () => {
    /*
     * THE SECOND BUG IN THIS CORNER, found on 2026-10-08 by pressing Send
     * twice on the Reports screen and reading "1 sent" with nothing in the
     * mailbox. `sendEmail` returns the EARLIER row when an idempotency key
     * repeats, carrying that row's status -- `sent` -- and this function read
     * the status without reading `deduplicated`. The letter was correctly not
     * duplicated; the count was a lie, on the one screen whose job is to say
     * who has been contacted.
     *
     * Asserting the specific numbers, not just "fewer", because the shape of
     * the fault was a number that looked plausible.
     */
    const g = await granteeOwing({ dueInDays: 3 });

    const first = await runReportReminders(liveEnv(), ctx(), new Date(), accepts);
    expect(first.granteesMailed).toBe(1);
    expect(first.deduplicated).toBe(0);

    const second = await runReportReminders(liveEnv(), ctx(), new Date(), accepts);
    expect(second.granteesMailed).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect(second.messagesRecorded).toBe(0);

    // And the chase count stays at one, because one letter was sent.
    const row = await db
      .prepare(`SELECT reminder_count AS n FROM report_periods WHERE id = ?`)
      .bind(g.periodId)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
    expect(await mailCount(g.granteeEmail!)).toBe(1);
  });

  it('records how many times a report has been chased, and when', async () => {
    /*
     * NOT THE IDEMPOTENCY MECHANISM. This answers what a program officer asks
     * before picking up the phone: an overdue row on its own is ambiguous
     * between a nonprofit ignoring us and a nonprofit nobody contacted, and
     * those call for opposite conversations.
     */
    const g = await granteeOwing({ dueInDays: 3 });
    await runReportReminders(liveEnv(), ctx(), new Date(), accepts);

    const row = await db
      .prepare(
        `SELECT reminder_count AS n, reminder_last_sent_at AS at
           FROM report_periods WHERE id = ?`,
      )
      .bind(g.periodId)
      .first<{ n: number; at: string | null }>();
    expect(row?.n).toBe(1);
    expect(row?.at).not.toBeNull();
  });

  /*
   * THE BUG THIS FILE USED TO PIN. A `suppressed` outcome -- no provider
   * configured, nothing sent -- counted as mailed and stamped the period, so
   * the compliance desk read "1 · today" and the Foundation believed it had
   * chased a nonprofit it had never contacted. The desk's entire job is to
   * tell "they are ignoring us" from "nobody has asked them", and this is the
   * fact it had backwards.
   */
  it('does not claim a chase for a message no provider ever took', async () => {
    const g = await granteeOwing({ dueInDays: 3 });
    const run = await runReportReminders(mailEnv(), ctx());

    expect(run.granteesMailed).toBe(0);
    expect(run.suppressed).toBe(1);
    // The row is still written, so "why did nobody get an email" has an answer.
    expect(run.messagesRecorded).toBe(1);

    const row = await db
      .prepare(
        `SELECT reminder_count AS n, reminder_last_sent_at AS at
           FROM report_periods WHERE id = ?`,
      )
      .bind(g.periodId)
      .first<{ n: number; at: string | null }>();
    expect(row?.n).toBe(0);
    expect(row?.at).toBeNull();
  });

  /*
   * A REFUSED MESSAGE WAS INVISIBLE TO EVERYBODY. `sendEmail` returns a
   * failure rather than throwing, so it fell through every branch: not
   * counted, not stamped, and not logged. A hard bounce from a grantee's mail
   * server left no trace at all.
   */
  /*
   * THE SECOND BUG IN THE SAME FUNCTION, found while fixing the first.
   *
   * The stamp was gated on `granteesMailed > 0` -- a RUNNING TOTAL across the
   * whole run, tested inside the per-organization loop. So once any one
   * organization was mailed, every organization after it had its report
   * periods stamped as reminded, whether or not its own message went. Two
   * grantees and one failure was enough to put a chase on the record for a
   * nonprofit nobody reached.
   */
  it('does not stamp one nonprofit because a different one was reached', async () => {
    const first = await granteeOwing({ dueInDays: 3 });
    const second = await granteeOwing({ dueInDays: 3 });

    // Accepts the first message, refuses the second.
    let call = 0;
    const flaky: typeof fetch = async (...args) => {
      call += 1;
      return call === 1 ? accepts(...args) : refuses(...args);
    };

    const run = await runReportReminders(liveEnv(), ctx(), new Date(), flaky);
    expect(run.granteesMailed).toBe(1);
    expect(run.failed).toBe(1);

    const rows = await db
      .prepare(
        `SELECT id, reminder_count AS n FROM report_periods WHERE id IN (?,?) ORDER BY id`,
      )
      .bind(first.periodId, second.periodId)
      .all<{ id: string; n: number }>();

    const byId = new Map((rows.results ?? []).map((r) => [r.id, r.n]));
    // Exactly one chase recorded, against exactly one nonprofit.
    expect([...byId.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('counts and logs a message the provider refused', async () => {
    const g = await granteeOwing({ dueInDays: 3 });
    const run = await runReportReminders(liveEnv(), ctx(), new Date(), refuses);

    expect(run.granteesMailed).toBe(0);
    expect(run.failed).toBe(1);

    const row = await db
      .prepare(`SELECT reminder_count AS n FROM report_periods WHERE id = ?`)
      .bind(g.periodId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);

    const logged = await db
      .prepare(`SELECT COUNT(*) AS n FROM error_log WHERE code = 'REPORT_REMINDER_NOT_DELIVERED'`)
      .first<{ n: number }>();
    expect(logged?.n).toBe(1);
  });

  it('leaves the count alone on a night nobody is due', async () => {
    const g = await granteeOwing({ dueInDays: 9 });
    const run = await runReportReminders(mailEnv(), ctx());
    expect(run.granteesMailed).toBe(0);
    expect(run.outstanding).toBe(1);

    const row = await db
      .prepare(`SELECT reminder_count AS n FROM report_periods WHERE id = ?`)
      .bind(g.periodId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
/*
 * SEEING WHAT TONIGHT WOULD DO, WITHOUT DOING IT.
 *
 * Reminders only ever ran from cron at 07:00, so the only way to learn what
 * they would do was to let them do it -- to a few hundred nonprofits. These
 * tests exist to make the plan trustworthy enough to decide on.
 *
 * The two assertions that matter most are the negative ones: no
 * `email_messages` row and no `reminder_count` stamp. Those are precisely the
 * two writes the last bug in this file got wrong -- it counted a suppressed
 * message as sent and stamped the period, so the compliance desk claimed
 * chases nobody had made. A dry run that wrote either would be the same class
 * of lie, told louder.
 */
describe('the plan for tonight', () => {
  const stamp = async (periodId: string) =>
    (await db
      .prepare(`SELECT reminder_count AS c, reminder_last_sent_at AS at
                  FROM report_periods WHERE id = ?`)
      .bind(periodId)
      .first<{ c: number; at: string | null }>())!;

  const errorRows = async (code: string) =>
    (await db
      .prepare(`SELECT COUNT(*) AS n FROM error_log WHERE code = ?`)
      .bind(code)
      .first<{ n: number }>())!.n;

  it('names the organization, the address and the report, on a reminder day', async () => {
    const g = await granteeOwing({ dueInDays: 14 });

    const plan = await planReportReminders(liveEnv(), admin);
    const mine = plan.wouldMail.find((o) => o.organizationId === g.orgId);

    expect(mine, 'the organization due in 14 days is in the plan').toBeDefined();
    expect(mine!.recipients).toEqual([g.granteeEmail]);
    expect(mine!.reports).toHaveLength(1);
    expect(mine!.reports[0]!.reportPeriodId).toBe(g.periodId);
    expect(mine!.reports[0]!.daysUntilDue).toBe(14);
    expect(mine!.reports[0]!.label).toBe('Final report');
  });

  it('writes no message row and leaves the reminder stamp alone', async () => {
    const g = await granteeOwing({ dueInDays: 14 });
    const before = await stamp(g.periodId);

    await planReportReminders(liveEnv(), admin);

    expect(await mailCount(g.granteeEmail!), 'no email_messages row').toBe(0);
    const after = await stamp(g.periodId);
    expect(after.c, 'reminder_count untouched').toBe(before.c);
    expect(after.at, 'reminder_last_sent_at untouched').toBe(before.at);
  });

  it('leaves an organization out on a day that is not a rung', async () => {
    const g = await granteeOwing({ dueInDays: 10 });

    const plan = await planReportReminders(liveEnv(), admin);

    expect(plan.wouldMail.some((o) => o.organizationId === g.orgId)).toBe(false);
    // Still owed, and the plan says so -- the distinction the screen needs.
    expect(plan.outstanding).toBeGreaterThan(0);
  });

  it('reports an organization with nobody to write to without logging it', async () => {
    const before = await errorRows('REPORT_REMINDER_NO_CONTACT');
    const g = await granteeOwing({ dueInDays: 3, withContact: false });

    const plan = await planReportReminders(liveEnv(), admin);
    const mine = plan.withNoContact.find((o) => o.organizationId === g.orgId);

    expect(mine, 'surfaced as unreachable').toBeDefined();
    expect(mine!.recipients).toEqual([]);
    expect(plan.wouldMail.some((o) => o.organizationId === g.orgId)).toBe(false);
    /*
     * The real run logs REPORT_REMINDER_NO_CONTACT here. The plan must not:
     * "writes nothing" includes the error log, or a panel refreshed a few
     * times would manufacture its own entries on the Data health screen.
     */
    expect(await errorRows('REPORT_REMINDER_NO_CONTACT'), 'nothing logged').toBe(before);
  });

  it('counts one letter per grantee account, not per organization', async () => {
    const g = await granteeOwing({ dueInDays: 0 });
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
      )
      .bind(newId(), `second-${crypto.randomUUID().slice(0, 8)}@example.org`, g.orgId, now, now)
      .run();

    const plan = await planReportReminders(liveEnv(), admin);
    const mine = plan.wouldMail.find((o) => o.organizationId === g.orgId)!;

    expect(mine.recipients, 'both logins listed').toHaveLength(2);
    // Two people who may each be the one who files, so two letters.
    expect(plan.lettersWouldSend).toBe(
      plan.wouldMail.reduce((n, o) => n + o.recipients.length, 0),
    );
  });

  it('says when no provider is configured, so an empty inbox is explainable', async () => {
    await granteeOwing({ dueInDays: 14 });

    expect((await planReportReminders(mailEnv(), admin)).transportConfigured).toBe(false);
    expect((await planReportReminders(liveEnv(), admin)).transportConfigured).toBe(true);
  });

  it('refuses a reviewer and an applicant', async () => {
    const reviewer = await appErrorFrom(planReportReminders(liveEnv(), reviewerSession()));
    expect(reviewer.code).toBe('FORBIDDEN');
    expect(reviewer.httpStatus).toBe(403);

    const applicant = await appErrorFrom(planReportReminders(liveEnv(), applicantSession(newId())));
    expect(applicant.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
/*
 * SENDING THEM ON PURPOSE, NOW.
 *
 * The count in the body is the safety mechanism, and these pin it. The failure
 * it exists for: an administrator reads a plan saying one letter to a test
 * mailbox, is interrupted, and confirms later -- by which time it is thirteen
 * letters to thirteen nonprofits. The screen said one, so the confirm must
 * mean one.
 */
describe('running the reminders now', () => {
  it('sends when the count matches what the plan showed', async () => {
    const g = await granteeOwing({ dueInDays: 3 });
    const plan = await planReportReminders(liveEnv(), admin);
    expect(plan.lettersWouldSend).toBeGreaterThan(0);

    const run = await runRemindersNow(liveEnv(), ctx(), admin, {
      expectLetters: plan.lettersWouldSend,
      fetcher: accepts,
    });

    expect(run.granteesMailed).toBe(plan.lettersWouldSend);
    expect(await mailCount(g.granteeEmail!)).toBe(1);
  });

  it('refuses when the plan has grown since it was read, and sends nothing', async () => {
    const g = await granteeOwing({ dueInDays: 3 });

    const e = await appErrorFrom(
      runRemindersNow(liveEnv(), ctx(), admin, { expectLetters: 0, fetcher: accepts }),
    );

    expect(e.code).toBe('VALIDATION_FAILED');
    /*
     * publicMessage, not message. `message` carries the INTERNAL text, so
     * asserting on it tests a string the administrator never reads -- and
     * passes or fails for reasons unrelated to what the screen says. The
     * specific number matters: it is what tells them the ground moved, and by
     * how much.
     */
    expect(e.publicMessage).toContain('not 0');
    expect(e.publicMessage).toContain('Nothing was sent');
    expect(await mailCount(g.granteeEmail!), 'no letter left the building').toBe(0);
  });

  it('refuses a body with no count at all, which is what a stray POST sends', async () => {
    const g = await granteeOwing({ dueInDays: 3 });

    const e = await appErrorFrom(
      runRemindersNow(liveEnv(), ctx(), admin, {
        expectLetters: Number.NaN,
        fetcher: accepts,
      }),
    );

    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.publicMessage).toBe('Review the plan before sending.');
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });

  it('accepts zero when there is genuinely nobody due, and reports it as not a failure', async () => {
    // Owed, but not on a rung: the state production is in before any
    // obligation exists, and the screen must not show it as an error.
    await granteeOwing({ dueInDays: 10 });

    const run = await runRemindersNow(liveEnv(), ctx(), admin, {
      expectLetters: 0,
      fetcher: accepts,
    });

    expect(run.granteesMailed).toBe(0);
    expect(run.messagesRecorded).toBe(0);
    expect(run.plan.lettersWouldSend).toBe(0);
  });

  it('refuses a reviewer, and does so before computing anything', async () => {
    const g = await granteeOwing({ dueInDays: 3 });

    const e = await appErrorFrom(
      runRemindersNow(liveEnv(), ctx(), reviewerSession(), {
        expectLetters: 1,
        fetcher: accepts,
      }),
    );

    expect(e.code).toBe('FORBIDDEN');
    expect(e.httpStatus).toBe(403);
    expect(await mailCount(g.granteeEmail!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
/*
 * THE DATE IN THE LETTER.
 *
 * On 2026-10-08 a grantee was sent "October 21, 2026. Due in 14 days." about a
 * report due 2026-10-22. The date and the day-count disagreed inside one
 * sentence, and both disagreed with the compliance desk, which said October
 * 22. `formatDayInZone` converted a plain YYYY-MM-DD to Central, and UTC
 * midnight in Central is the previous evening.
 *
 * Nothing caught it, because every test here asserted WHO was mailed and
 * WHETHER, never WHAT the letter said. The provider's payload is the last
 * place the text exists before it reaches somebody, so that is what this reads.
 */
describe('what the letter actually says', () => {
  /** A provider that accepts and keeps the payload it was given. */
  const capturing = () => {
    const sent: { subject: string; html: string; text: string }[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body ?? '{}'));
      sent.push({ subject: body.subject ?? '', html: body.html ?? '', text: body.text ?? '' });
      return new Response(JSON.stringify({ id: 'msg_capture' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { sent, fetcher };
  };

  it('names the due date the record holds, not the day before', async () => {
    const g = await granteeOwing({ dueInDays: 14 });
    /*
     * The plain YYYY-MM-DD a human typed, which is what requestUpdates writes.
     * Through forceDueDate because 0029 refuses a bare UPDATE of due_date --
     * that trigger caught this very test when it was written with one.
     */
    await forceDueDate(g.periodId, '2026-10-22');

    const { sent, fetcher } = capturing();
    await runReportReminders(
      liveEnv(),
      ctx(),
      new Date('2026-10-08T17:12:00.000Z'),
      fetcher,
    );

    expect(sent).toHaveLength(1);
    const letter = sent[0]!;
    expect(letter.html).toContain('October 22, 2026');
    expect(letter.text).toContain('October 22, 2026');
    // The exact string that went out on 2026-10-08.
    expect(letter.html).not.toContain('October 21, 2026');
    expect(letter.text).not.toContain('October 21, 2026');
  });

  it('agrees with its own day-count, which is how the bug announced itself', async () => {
    const g = await granteeOwing({ dueInDays: 14 });
    await forceDueDate(g.periodId, '2026-10-22');

    const { sent, fetcher } = capturing();
    await runReportReminders(liveEnv(), ctx(), new Date('2026-10-08T17:12:00.000Z'), fetcher);

    /*
     * "October 22, 2026. Due in 14 days." Both halves are generated from the
     * same due_date by different code -- the date by a formatter, the count by
     * daysUntil -- so a disagreement between them is the signature of exactly
     * this class of fault.
     */
    const text = sent[0]!.text;
    expect(text).toContain('October 22, 2026');
    expect(text).toContain('14 days');
  });
});
