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
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision } from '../src/lib/awards';
import { buildReportForm } from '../src/lib/reportForm';
import {
  runReportReminders, isReminderDay, reportsOwed,
  REMIND_BEFORE_DAYS, OVERDUE_EVERY_DAYS, OVERDUE_STOP_AFTER_DAYS,
} from '../src/lib/reportReminders';
import { REPORT_REMINDER } from '../src/lib/emailTemplates';
import type { Env, Session } from '../src/types';

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

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
    const run = await runReportReminders(mailEnv(), ctx());
    expect(run.granteesMailed).toBe(1);
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

    const run = await runReportReminders(mailEnv(), ctx());
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

  it('records how many times a report has been chased, and when', async () => {
    /*
     * NOT THE IDEMPOTENCY MECHANISM. This answers what a program officer asks
     * before picking up the phone: an overdue row on its own is ambiguous
     * between a nonprofit ignoring us and a nonprofit nobody contacted, and
     * those call for opposite conversations.
     */
    const g = await granteeOwing({ dueInDays: 3 });
    await runReportReminders(mailEnv(), ctx());

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
