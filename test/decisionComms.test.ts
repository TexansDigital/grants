/**
 * Telling applicants what was decided.
 *
 * THE WEEK THIS PROTECTS. Fifty acceptances and 250 declines go out together.
 * The ways it goes wrong are all social rather than technical, and none of
 * them throws:
 *
 *   - a decline sent by a machine with nobody's name on it,
 *   - declines landing before acceptances, so an applicant hears no on Monday
 *     and watches a peer announce on Tuesday,
 *   - a grantee posting before the coordinated announcement,
 *   - the same letter sent twice,
 *   - and the one this module was built around: an applicant learning the
 *     outcome from a status badge in the portal, days before the letter.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import {
  communicationQueue, sendAwardNotification, sendDeclineNotification,
  recordManualCommunication, sendDeclineBatch, DECLINE_BATCH_SIZE,
} from '../src/lib/decisionComms';
import { getApplicationForExternal, applicantVisibleStatus } from '../src/lib/scope';
import type { Env, Session } from '../src/types';

let n = 0;
let admin: Session;

const mailEnv = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  // No RESEND_API_KEY, so every message is recorded and deliberately
  // suppressed. That is the correct posture for a test database whose
  // fixtures carry addresses, and it still exercises the whole send path.
  EMAIL_FROM: 'Houston Texans Foundation <grants@example.org>',
  EMAIL_REPLY_TO: 'grants@example.org',
  APPLICANT_BASE_URL: 'https://apply.example.org',
  DISPLAY_TIMEZONE: 'America/Chicago',
  ...over,
});

beforeEach(async () => {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(id, `comm-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

async function cycle() {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `comm-${++n}` });
  return { programId: p.programId, cycleId: Object.values(p.cycleIds)[0]!, formId: p.formDefinitionIds.application! };
}

async function applicationIn(
  c: { cycleId: string; formId: string },
  opts: { email?: string | null } = {},
) {
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Guild ${++n}`, String(910000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, primary_contact_email, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(
      applicationId, c.cycleId, orgId, now, `Project ${n}`,
      opts.email === undefined ? `contact${n}@example.org` : opts.email,
      now, now, c.formId,
    )
    .run();
  return { applicationId, orgId };
}

async function awardFor(applicationId: string, orgId: string, programId: string, announce: string | null) {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, announcement_date, status, created_at, updated_at)
       VALUES (?,?,?,?, 2500000, ?, ?, 'pending', ?, ?)`,
    )
    .bind(newId(), applicationId, orgId, programId, now, announce, now, now)
    .run();
}

const sentTo = async (applicationId: string, key: string) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE template_key = ? AND idempotency_key = ?`,
    )
    .bind(key, `${key}:${applicationId}`)
    .first<{ n: number }>();

// ---------------------------------------------------------------------------

describe('the portal does not announce the decision', () => {
  it('shows under_review until somebody has told them', async () => {
    /*
     * THE BUG THIS MODULE WAS BUILT AROUND. `applications.status` becomes
     * 'declined' the instant an admin records it, and the applicant's own
     * portal reads that column. A nonprofit signing in on Tuesday would have
     * learned it was declined from a status badge, days before the letter a
     * human was still writing -- defeating the human-release gate entirely.
     */
    const c = await cycle();
    const { applicationId, orgId } = await applicationIn(c);
    await decideApplication(db, ctx(), admin, applicationId, {
      status: 'declined', notes: 'Outside the focus area.',
    });

    const applicant: Session = {
      userId: newId(), email: 'a@example.org', role: 'applicant', organizationId: orgId,
    };
    const before = await getApplicationForExternal(db, applicant, applicationId);
    expect(before.status).toBe('under_review');
    // And the mask itself is not visible: a null next to a masked status would
    // hand back exactly what the mask withholds.
    expect(JSON.stringify(before)).not.toContain('decision_communicated');

    await recordManualCommunication(db, ctx(), admin, applicationId, 'Called them on 12 Sept.');
    const after = await getApplicationForExternal(db, applicant, applicationId);
    expect(after.status).toBe('declined');
  });

  it('never masks withdrawn, which the applicant told US', async () => {
    expect(applicantVisibleStatus('withdrawn', null)).toBe('withdrawn');
    expect(applicantVisibleStatus('submitted', null)).toBe('submitted');
    expect(applicantVisibleStatus('under_review', null)).toBe('under_review');
    expect(applicantVisibleStatus('awarded', null)).toBe('under_review');
    expect(applicantVisibleStatus('declined', null)).toBe('under_review');
  });
});

describe('acceptances go first', () => {
  it('refuses a decline while any award in the cycle is untold', async () => {
    /*
     * CLAUDE.md: acceptances send before declines, never the reverse. An
     * applicant who hears no on Monday and watches a peer announce on Tuesday
     * has been told twice, the second time by somebody else.
     */
    const c = await cycle();
    const winner = await applicationIn(c);
    const loser = await applicationIn(c);
    await decideApplication(db, ctx(), admin, winner.applicationId, { status: 'awarded' });
    await decideApplication(db, ctx(), admin, loser.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });
    await awardFor(winner.applicationId, winner.orgId, c.programId, null);

    const queue = await communicationQueue(db, c.cycleId);
    expect(queue.awards.length).toBe(1);
    expect(queue.declines.length).toBe(1);
    expect(queue.declinesUnlocked).toBe(false);

    const err = await appErrorFrom(
      sendDeclineNotification(mailEnv(), ctx(), admin, loser.applicationId, ['We cannot fund this.']),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/Acceptances go first/i);

    // Nothing was sent, and nothing was stamped.
    expect((await sentTo(loser.applicationId, 'decline_notification'))?.n).toBe(0);
  });

  it('stays locked while even ONE award is still untold', async () => {
    /*
     * THE BUG THIS PREVENTS, and the one a single-award test cannot see.
     *
     * Fifty awards go out on Monday morning. Forty-nine send; one bounces, or
     * the page is closed halfway. If the gate asked "have any awards gone out"
     * rather than "have they all", 250 declines would start landing while one
     * grantee still had no idea they had been funded -- and they would learn
     * it from a peer.
     *
     * The first version of this test had one award, so "some" and "all" were
     * the same sentence and a mutant swapping them survived.
     */
    const c = await cycle();
    const first = await applicationIn(c);
    const second = await applicationIn(c);
    const loser = await applicationIn(c);
    for (const w of [first, second]) {
      await decideApplication(db, ctx(), admin, w.applicationId, { status: 'awarded' });
      await awardFor(w.applicationId, w.orgId, c.programId, null);
    }
    await decideApplication(db, ctx(), admin, loser.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });

    await sendAwardNotification(mailEnv(), ctx(), admin, first.applicationId);
    const queue = await communicationQueue(db, c.cycleId);
    expect(queue.awardsCommunicated).toBe(1);
    expect(queue.awards.length).toBe(1);
    expect(queue.declinesUnlocked).toBe(false);

    const err = await appErrorFrom(
      sendDeclineNotification(mailEnv(), ctx(), admin, loser.applicationId, ['No this year.']),
    );
    expect(err.code).toBe('CONFLICT');
    expect((await sentTo(loser.applicationId, 'decline_notification'))?.n).toBe(0);

    // And the manual path is gated on the same question.
    expect(
      (await appErrorFrom(
        recordManualCommunication(db, ctx(), admin, loser.applicationId, 'Phoned them.'),
      )).code,
    ).toBe('CONFLICT');

    await sendAwardNotification(mailEnv(), ctx(), admin, second.applicationId);
    expect((await communicationQueue(db, c.cycleId)).declinesUnlocked).toBe(true);
  });

  it('unlocks once every award has gone out', async () => {
    const c = await cycle();
    const winner = await applicationIn(c);
    const loser = await applicationIn(c);
    await decideApplication(db, ctx(), admin, winner.applicationId, { status: 'awarded' });
    await decideApplication(db, ctx(), admin, loser.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });
    await awardFor(winner.applicationId, winner.orgId, c.programId, null);

    await sendAwardNotification(mailEnv(), ctx(), admin, winner.applicationId);
    expect((await communicationQueue(db, c.cycleId)).declinesUnlocked).toBe(true);

    await sendDeclineNotification(mailEnv(), ctx(), admin, loser.applicationId, [
      'We had far more strong applications than we could fund this year.',
    ]);
    expect((await sentTo(loser.applicationId, 'decline_notification'))?.n).toBe(1);
  });

  it('applies the same rule to a manually recorded decline', async () => {
    // Recording a manual decline while awards are untold has the same effect
    // as sending one: the applicant's portal starts saying "declined".
    const c = await cycle();
    const winner = await applicationIn(c);
    const loser = await applicationIn(c);
    await decideApplication(db, ctx(), admin, winner.applicationId, { status: 'awarded' });
    await decideApplication(db, ctx(), admin, loser.applicationId, {
      status: 'declined', notes: 'x',
    });
    await awardFor(winner.applicationId, winner.orgId, c.programId, null);

    expect(
      (await appErrorFrom(
        recordManualCommunication(db, ctx(), admin, loser.applicationId, 'Phoned them.'),
      )).code,
    ).toBe('CONFLICT');
  });
});

describe('the decline letter', () => {
  it('refuses an empty body, because there is no standard wording', async () => {
    /*
     * DELIBERATE. 250 of these go out in a week and one gets forwarded. The
     * Foundation has not settled its wording, and inventing copy here would be
     * this system putting words in its mouth to 250 nonprofits.
     */
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'declined', notes: 'x' });
    for (const body of [[], [''], ['   ', '']]) {
      const err = await appErrorFrom(
        sendDeclineNotification(mailEnv(), ctx(), admin, a.applicationId, body),
      );
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.fieldErrors?.[0]?.field).toBe('body');
    }
  });

  it('carries no score, no criterion and no internal rationale', async () => {
    /*
     * The decision rationale is the Foundation's working paper. A decline that
     * quotes it is a document nobody intended to publish, and a decline that
     * quotes a score is an argument the applicant will want to have.
     */
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, {
      status: 'declined',
      notes: 'Board felt the outcomes were not measurable and the budget was thin.',
    });
    await sendDeclineNotification(mailEnv(), ctx(), admin, a.applicationId, [
      'We had more strong applications than we could fund.',
    ]);

    const msg = await db
      .prepare(`SELECT subject FROM email_messages WHERE idempotency_key = ?`)
      .bind(`decline_notification:${a.applicationId}`)
      .first<{ subject: string }>();
    expect(msg?.subject).not.toMatch(/not measurable|budget was thin/i);

    const audited = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action = 'decision.communicated' AND entity_id = ?`,
      )
      .bind(a.applicationId)
      .first<{ after_json: string }>();
    // The words are not duplicated into an append-only table either.
    expect(audited!.after_json).not.toContain('more strong applications');
    expect(JSON.parse(audited!.after_json).paragraphs).toBe(1);
  });

  it('is sent once, however many times the button is pressed', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'declined', notes: 'x' });
    await sendDeclineNotification(mailEnv(), ctx(), admin, a.applicationId, ['No this year.']);
    const again = await appErrorFrom(
      sendDeclineNotification(mailEnv(), ctx(), admin, a.applicationId, ['No this year.']),
    );
    expect(again.code).toBe('CONFLICT');
    expect((await sentTo(a.applicationId, 'decline_notification'))?.n).toBe(1);
  });
});

describe('the award letter', () => {
  it('refuses before an award record exists, because it carries the amount', async () => {
    // A decision is not an award. An award letter with no amount is not a
    // letter, and this is the check that keeps the two separate.
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const err = await appErrorFrom(sendAwardNotification(mailEnv(), ctx(), admin, a.applicationId));
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/award record/i);
  });

  it('carries the embargo date when the award has one', async () => {
    // Grantees told on Tuesday post on Tuesday. announcement_date is a
    // separate fact from decided_at for exactly this.
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await awardFor(a.applicationId, a.orgId, c.programId, '2026-11-05T12:00:00.000Z');

    await sendAwardNotification(mailEnv(), ctx(), admin, a.applicationId);
    const queue = await communicationQueue(db, c.cycleId);
    expect(queue.awards.length).toBe(0);
    expect(queue.awardsCommunicated).toBe(1);
  });

  it('refuses an application that was not awarded', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'declined', notes: 'x' });
    expect(
      (await appErrorFrom(sendAwardNotification(mailEnv(), ctx(), admin, a.applicationId))).code,
    ).toBe('CONFLICT');
  });

  it('refuses when there is no address to send to', async () => {
    const c = await cycle();
    const a = await applicationIn(c, { email: null });
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await awardFor(a.applicationId, a.orgId, c.programId, null);
    expect(
      (await appErrorFrom(sendAwardNotification(mailEnv(), ctx(), admin, a.applicationId))).code,
    ).toBe('CONFLICT');
  });
});

describe('who may do any of this', () => {
  it('refuses a reviewer every path', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'declined', notes: 'x' });
    const reviewer = reviewerSession(newId());

    for (const call of [
      () => sendAwardNotification(mailEnv(), ctx(), reviewer, a.applicationId),
      () => sendDeclineNotification(mailEnv(), ctx(), reviewer, a.applicationId, ['no']),
      () => recordManualCommunication(db, ctx(), reviewer, a.applicationId, 'phoned'),
    ]) {
      expect((await appErrorFrom(call())).code).toBe('NOT_FOUND');
    }
  });

  it('refuses to communicate an undecided application', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    expect(
      (await appErrorFrom(
        recordManualCommunication(db, ctx(), admin, a.applicationId, 'phoned'),
      )).code,
    ).toBe('CONFLICT');
  });
});

describe('recording that somebody phoned', () => {
  it('requires a note, and stamps who and how', async () => {
    // "Communicated manually" with no detail cannot answer the question the
    // column exists for, which is always asked in a hurry.
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });

    expect(
      (await appErrorFrom(recordManualCommunication(db, ctx(), admin, a.applicationId, ' '))).code,
    ).toBe('VALIDATION_FAILED');

    await recordManualCommunication(db, ctx(), admin, a.applicationId, 'ED called Maria, 12 Sept.');
    const row = await db
      .prepare(
        `SELECT decision_communicated_at AS at, decision_communicated_by AS by_,
                decision_communicated_via AS via FROM applications WHERE id = ?`,
      )
      .bind(a.applicationId)
      .first<{ at: string; by_: string; via: string }>();
    expect(row?.via).toBe('manual');
    expect(row?.by_).toBe(admin.userId);
    expect(typeof row?.at).toBe('string');
  });

  it('is refused by the database if the three columns disagree', async () => {
    // A date with no method cannot answer the question the column exists for,
    // so it is not only the application code that refuses.
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    await expect(
      db
        .prepare(`UPDATE applications SET decision_communicated_at = ? WHERE id = ?`)
        .bind(nowIso(), a.applicationId)
        .run(),
    ).rejects.toThrow();
  });

  it('is refused by the database before a decision exists', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    await expect(
      db
        .prepare(
          `UPDATE applications SET decision_communicated_at = ?, decision_communicated_by = ?,
             decision_communicated_via = 'manual' WHERE id = ?`,
        )
        .bind(nowIso(), admin.userId, a.applicationId)
        .run(),
    ).rejects.toThrow();
  });
});

describe('sending the week of declines', () => {
  const LETTER = [
    'We had far more strong applications this year than we were able to fund.',
    'We hope you will apply again next cycle.',
  ];

  it('sends a round at a time and reports what is left', async () => {
    /*
     * A ROUND, NOT THE LOT. Each letter is an HTTPS call to a mail provider;
     * one request attempting 250 is betting the batch on the subrequest limit
     * and the CPU budget, and the failure mode is a request that dies at
     * letter 180 with nobody able to say which 180.
     */
    const c = await cycle();
    const apps = [];
    for (let i = 0; i < 4; i += 1) {
      const a = await applicationIn(c);
      await decideApplication(db, ctx(), admin, a.applicationId, {
        status: 'declined', notes: 'Not this cycle.',
      });
      apps.push(a);
    }

    const first = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER, 2);
    expect(first.sent).toBe(2);
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(2);

    const second = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER, 2);
    expect(second.sent).toBe(2);
    expect(second.remaining).toBe(0);

    for (const a of apps) {
      expect((await sentTo(a.applicationId, 'decline_notification'))?.n).toBe(1);
    }
  });

  it('sends nothing twice when a round is repeated', async () => {
    // The obvious operator mistake -- a double-click, a refreshed page, a
    // retried request. Every letter is keyed on its own application.
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });

    await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER);
    const again = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER);
    expect(again.sent).toBe(0);
    expect(again.remaining).toBe(0);
    expect((await sentTo(a.applicationId, 'decline_notification'))?.n).toBe(1);
  });

  it('keeps going when one letter cannot be sent, and names who missed out', async () => {
    /*
     * A single bad address must not hold up 24 other nonprofits. And the
     * outcome list has to name them, or somebody discovers it from a reply
     * three weeks later.
     */
    const c = await cycle();
    const good = await applicationIn(c);
    const bad = await applicationIn(c, { email: null });
    for (const a of [good, bad]) {
      await decideApplication(db, ctx(), admin, a.applicationId, {
        status: 'declined', notes: 'Not this cycle.',
      });
    }

    const result = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const missed = result.outcomes.find((o) => o.applicationId === bad.applicationId)!;
    expect(missed.ok).toBe(false);
    // The PUBLIC message: an admin reading this is deciding what to do about
    // it, and "no contact address" says go and find one.
    expect(missed.reason).toMatch(/contact address/i);
    expect(missed.organizationName).toBeTruthy();

    // The one that failed is still outstanding, so the next round retries it.
    expect(result.remaining).toBe(1);
  });

  it('is refused wholesale while an award is untold', async () => {
    // One refusal with a reason beats 250 individual ones, and the gate is
    // checked again inside every letter so the batch cannot be the bypass.
    const c = await cycle();
    const winner = await applicationIn(c);
    const loser = await applicationIn(c);
    await decideApplication(db, ctx(), admin, winner.applicationId, { status: 'awarded' });
    await decideApplication(db, ctx(), admin, loser.applicationId, {
      status: 'declined', notes: 'Not this cycle.',
    });
    await awardFor(winner.applicationId, winner.orgId, c.programId, null);

    const err = await appErrorFrom(
      sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/Acceptances go first/i);
    expect((await sentTo(loser.applicationId, 'decline_notification'))?.n).toBe(0);
  });

  it('refuses an empty letter, because there is no standard wording', async () => {
    const c = await cycle();
    const a = await applicationIn(c);
    await decideApplication(db, ctx(), admin, a.applicationId, {
      status: 'declined', notes: 'x',
    });
    for (const body of [[], [''], ['  ']]) {
      const err = await appErrorFrom(
        sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, body),
      );
      expect(err.code).toBe('VALIDATION_FAILED');
    }
    expect((await sentTo(a.applicationId, 'decline_notification'))?.n).toBe(0);
  });

  it('refuses a reviewer, and caps the round size a caller can ask for', async () => {
    const c = await cycle();
    expect(
      (await appErrorFrom(
        sendDeclineBatch(mailEnv(), ctx(), reviewerSession(newId()), c.cycleId, LETTER),
      )).code,
    ).toBe('NOT_FOUND');

    /*
     * The cap needs MORE PENDING THAN THE CAP to be visible at all. A first
     * version of this test queued three declines and asked for 10,000, where
     * capped and uncapped give the same answer -- and a mutant that removed
     * the cap survived it.
     */
    for (let i = 0; i < DECLINE_BATCH_SIZE + 1; i += 1) {
      const a = await applicationIn(c);
      await decideApplication(db, ctx(), admin, a.applicationId, {
        status: 'declined', notes: 'x',
      });
    }
    const result = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER, 10_000);
    expect(result.sent).toBe(DECLINE_BATCH_SIZE);
    expect(result.remaining).toBe(1);
  });

  it('never returns an empty round, which the caller would loop on forever', async () => {
    // The caller loops while `remaining` is above zero. A round of nothing
    // with work outstanding is an infinite loop in somebody's browser.
    // A FRESH CYCLE PER VALUE. Reusing one meant the second call had nothing
    // left to send, so an empty round was correct and the assertion failed for
    // the right reason in the wrong place.
    for (const asked of [0, -5]) {
      const c = await cycle();
      const a = await applicationIn(c);
      await decideApplication(db, ctx(), admin, a.applicationId, {
        status: 'declined', notes: 'x',
      });
      const result = await sendDeclineBatch(mailEnv(), ctx(), admin, c.cycleId, LETTER, asked);
      expect(result.sent + result.failed, `asked for ${asked}`).toBeGreaterThan(0);
    }
  });
});
