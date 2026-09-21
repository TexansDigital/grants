/**
 * A grantee accepting, or refusing, an award.
 *
 * WHAT THIS CLOSES. `awards.status` has admitted 'active' since 0012 and
 * nothing could put an award into it; `award.accepted` has been a declared
 * audit action since Phase 0 and nothing wrote it; data health has checked
 * active awards for a missing W-9 and could never fire. The award letter told
 * a grantee to sign in and see what was needed from them, and there was
 * nothing there.
 *
 * WHAT IS AT RISK NOW THAT THERE IS. These are external, magic-link sessions
 * acting on money. The failures that matter are one organization reaching
 * another's award, an acceptance nobody can characterise later, and an active
 * award with no reporting schedule — a grantee told they are overdue for
 * something that was never scheduled.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db, ctxFor, adminSession, applicantSession, reviewerSession, appErrorFrom,
} from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import {
  createAwardFromDecision, budgetByProgram, amendAward, amendmentHistory,
} from '../src/lib/awards';
import {
  awardsAwaitingResponse, acceptAward, declineAward, recordAwardDocument, awardPaperwork,
} from '../src/lib/acceptance';
import { schedulePayment, recordPayment } from '../src/lib/payments';
import type { Session } from '../src/types';

const ATTESTATION =
  'I am authorised to accept this grant on behalf of my organization and agree to ' +
  'the reporting dates shown.';

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
    .bind(id, `acc-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

/** An awarded application with its award record, and a grantee who can answer. */
async function offered(opts: { term?: boolean } = { term: true }) {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `acc-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const userId = newId();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Chorus ${n}`, String(960000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
    )
    .bind(userId, `grantee-${crypto.randomUUID().slice(0, 8)}@example.org`, orgId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(applicationId, cycleId, orgId, now, `Project ${n}`, now, now, p.formDefinitionIds.application!)
    .run();
  await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });

  const award = await createAwardFromDecision(db, ctx(), admin, applicationId, {
    awardedAmountCents: 2_500_000,
    termStart: opts.term ? new Date(Date.now() - 86_400_000).toISOString() : null,
    termEnd: opts.term ? new Date(Date.now() + 364 * 86_400_000).toISOString() : null,
  });

  return {
    programId: p.programId, orgId, applicationId, awardId: award.awardId,
    grantee: applicantSession(orgId, userId) as Session,
  };
}

const awardRow = async (awardId: string) =>
  (await db
    .prepare(
      `SELECT status, accepted_at AS acceptedAt, accepted_by_user_id AS acceptedBy,
              declined_by_grantee_at AS declinedAt, grantee_response_note AS note,
              w9_received_at AS w9
         FROM awards WHERE id = ?`,
    )
    .bind(awardId)
    .first<{
      status: string; acceptedAt: string | null; acceptedBy: string | null;
      declinedAt: string | null; note: string | null; w9: string | null;
    }>())!;

// ---------------------------------------------------------------------------

describe('what a grantee is shown', () => {
  it('lists only the unanswered awards of their own organization', async () => {
    const mine = await offered();
    const theirs = await offered();

    const list = await awardsAwaitingResponse(db, mine.grantee);
    expect(list.map((a) => a.id)).toEqual([mine.awardId]);
    expect(list[0]!.awardedAmountCents).toBe(2_500_000);
    expect(JSON.stringify(list)).not.toContain(theirs.awardId);
  });

  it('drops off the list once answered', async () => {
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    expect(await awardsAwaitingResponse(db, s.grantee)).toEqual([]);
  });
});

describe('accepting', () => {
  it('makes the award active, names who accepted, and schedules the reports', async () => {
    /*
     * 'active' means "reports expected". An active award with no periods is a
     * grantee who will be told they are overdue for something that was never
     * scheduled.
     */
    const s = await offered();
    const result = await acceptAward(db, ctx(), s.grantee, s.awardId, {
      attestationText: ATTESTATION,
    });

    const row = await awardRow(s.awardId);
    expect(row.status).toBe('active');
    expect(row.acceptedBy).toBe(s.grantee.userId);
    expect(typeof row.acceptedAt).toBe('string');
    expect(result.reportPeriodsCreated).toBeGreaterThan(0);

    const periods = await db
      .prepare(`SELECT COUNT(*) AS n FROM report_periods WHERE award_id = ?`)
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(periods?.n).toBe(result.reportPeriodsCreated);
  });

  it('records the exact words the grantee saw', async () => {
    /*
     * A button with no statement beside it produces an acceptance nobody can
     * characterise later. The wording is on the audit row, so "what did they
     * agree to" survives a later change to the copy.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    const row = await db
      .prepare(
        `SELECT after_json FROM audit_log WHERE action = 'award.accepted' AND entity_id = ?`,
      )
      .bind(s.awardId)
      .first<{ after_json: string }>();
    expect(JSON.parse(row!.after_json).attestation).toBe(ATTESTATION);
  });

  it('refuses with no attestation', async () => {
    const s = await offered();
    for (const bad of ['', '   ']) {
      const err = await appErrorFrom(
        acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: bad }),
      );
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.fieldErrors?.[0]?.field).toBe('attested');
    }
    expect((await awardRow(s.awardId)).status).toBe('pending');
  });

  it('refuses a second acceptance, and says which refusal it is', async () => {
    /*
     * TWO GUARDS ANSWER THIS, and they are not interchangeable. Dropping the
     * "already accepted" check leaves the status check to catch it, which
     * still refuses -- so a mutation that removed it survived a test asserting
     * only the code. What the grantee reads is different, and worse: "this
     * grant is no longer waiting on you" is what somebody sees when an award
     * was withdrawn, and telling an accepted grantee that at the moment they
     * double-click is alarming and untrue.
     *
     * The audit count is asserted too, because a second acceptance must not
     * write a second `award.accepted` row against an award accepted once.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    const err = await appErrorFrom(
      acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION }),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/already accepted/i);

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'award.accepted' AND entity_id = ?`,
      )
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('stands even when no reporting schedule can be generated', async () => {
    /*
     * An award imported or created without term dates generates nothing, and
     * generateReportPeriods says so rather than inventing a deadline. Rolling
     * back somebody's "yes" because our own scheduler had nothing to work from
     * would be the wrong half to sacrifice.
     */
    const s = await offered({ term: false });
    const result = await acceptAward(db, ctx(), s.grantee, s.awardId, {
      attestationText: ATTESTATION,
    });
    expect(result.reportPeriodsCreated).toBe(0);
    expect(result.reportPeriodsSkipped).not.toBeNull();
    expect((await awardRow(s.awardId)).status).toBe('active');
  });
});

describe('another organization', () => {
  it('404s on every path, rather than confirming the award exists', async () => {
    const mine = await offered();
    const theirs = await offered();

    for (const call of [
      () => acceptAward(db, ctx(), mine.grantee, theirs.awardId, { attestationText: ATTESTATION }),
      () => declineAward(db, ctx(), mine.grantee, theirs.awardId, 'not for us'),
    ]) {
      expect((await appErrorFrom(call())).code).toBe('NOT_FOUND');
    }
    expect((await awardRow(theirs.awardId)).status).toBe('pending');
  });
});

describe('refusing', () => {
  it('cancels the award and returns the money to the uncommitted balance', async () => {
    /*
     * THE POINT OF HAVING A REFUSAL PATH. Without one the award sits pending
     * forever, the committed total stays wrong, and the portfolio cannot say
     * what happened. Cancelled awards are already excluded from committed
     * totals, so the money frees up the moment the grantee says no.
     */
    const s = await offered();
    const before = (await budgetByProgram(db, admin)).find((b) => b.programId === s.programId)!;
    expect(before.committedCents).toBe(2_500_000);

    await declineAward(db, ctx(), s.grantee, s.awardId, 'We lost the matching funder.');

    const row = await awardRow(s.awardId);
    expect(row.status).toBe('cancelled');
    expect(row.note).toBe('We lost the matching funder.');
    expect(typeof row.declinedAt).toBe('string');

    const after = (await budgetByProgram(db, admin)).find((b) => b.programId === s.programId)!;
    expect(after.committedCents).toBe(0);
  });

  it('refuses a refusal with no reason, in the code and in the schema', async () => {
    const s = await offered();
    expect((await appErrorFrom(declineAward(db, ctx(), s.grantee, s.awardId, ' '))).code)
      .toBe('VALIDATION_FAILED');

    // And not only in the code: a refusal with nothing behind it is a gap
    // exactly where the next person asks what happened.
    await expect(
      db
        .prepare(`UPDATE awards SET declined_by_grantee_at = ? WHERE id = ?`)
        .bind(nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow();
  });

  it('cannot refuse after accepting', async () => {
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    expect(
      (await appErrorFrom(declineAward(db, ctx(), s.grantee, s.awardId, 'changed our mind'))).code,
    ).toBe('CONFLICT');
  });

  it('is refused by the schema if both stamps are set', async () => {
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    await expect(
      db
        .prepare(
          `UPDATE awards SET declined_by_grantee_at = ?, grantee_response_note = 'x' WHERE id = ?`,
        )
        .bind(nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow();
  });

  it('is refused by the schema if an acceptance has no actor', async () => {
    const s = await offered();
    await expect(
      db
        .prepare(`UPDATE awards SET accepted_at = ? WHERE id = ?`)
        .bind(nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow();
  });
});

describe('a refused award takes its payments with it', () => {
  it('cancels every scheduled payment, so none stays on a finance list', async () => {
    /*
     * THE BUG THIS CLOSES, reproduced by an adversarial review and not by this
     * suite. A refusal set the award to `cancelled` and touched nothing else.
     * Its payments stayed `scheduled` -- still in payments_due_idx, so still
     * on whatever list finance works from -- more could be scheduled against
     * the refused award, and one could be marked PAID. The dashboard then
     * showed money disbursed against nothing committed.
     */
    const s = await offered();
    const p = await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 1_000_000,
      scheduledDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    await declineAward(db, ctx(), s.grantee, s.awardId, 'We lost the matching funder.');

    const row = await db
      .prepare(`SELECT status, note FROM payments WHERE id = ?`)
      .bind(p.id)
      .first<{ status: string; note: string }>();
    expect(row?.status).toBe('cancelled');
    expect(row?.note).toMatch(/did not accept/i);

    // Cancelled, not deleted: "we scheduled this and then did not pay it" is a
    // question somebody asks.
    const still = await db
      .prepare(`SELECT COUNT(*) AS n FROM payments WHERE id = ?`)
      .bind(p.id)
      .first<{ n: number }>();
    expect(still?.n).toBe(1);
  });

  it('leaves nothing payable behind it', async () => {
    const s = await offered();
    const p = await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 500_000,
      scheduledDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    await declineAward(db, ctx(), s.grantee, s.awardId, 'Not able to deliver it.');

    // The cancelled payment cannot now be recorded as paid.
    expect(
      (await appErrorFrom(
        recordPayment(db, ctx(), admin, p.id, {
          paidDate: nowIso(), referenceNumber: 'CHQ-1',
        }),
      )).code,
    ).toBe('CONFLICT');
  });
});

describe('recording a document', () => {
  it('stamps it, and lets a mistaken date be cleared', async () => {
    // Clearing a wrong date is a legitimate correction, and the audit row is
    // what makes it a correction rather than a disappearance.
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });

    const when = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await recordAwardDocument(db, ctx(), admin, s.awardId, 'w9', when);
    expect((await awardRow(s.awardId)).w9).toBe(when);

    await recordAwardDocument(db, ctx(), admin, s.awardId, 'w9', null);
    expect((await awardRow(s.awardId)).w9).toBeNull();

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'award.amended' AND entity_id = ?`,
      )
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(2);
  });

  it('refuses a grantee, because receipt is a fact only the Foundation has', async () => {
    /*
     * A grantee marking their own W-9 received would make the data health
     * check that reads these columns meaningless.
     */
    const s = await offered();
    expect(
      (await appErrorFrom(
        recordAwardDocument(db, ctx(), s.grantee, s.awardId, 'w9', nowIso()),
      )).code,
    ).toBe('NOT_FOUND');
  });

  it('refuses a document it does not track, and an unreadable date', async () => {
    const s = await offered();
    expect(
      (await appErrorFrom(
        recordAwardDocument(db, ctx(), admin, s.awardId, 'passport' as 'w9', nowIso()),
      )).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await appErrorFrom(recordAwardDocument(db, ctx(), admin, s.awardId, 'w9', 'last Tuesday'))).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('makes the data health check reachable at last', async () => {
    /*
     * These checks have existed since the awards phase and could never fire,
     * because no award could become active. This is the test that says they
     * can now.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    const missing = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM awards
          WHERE id = ? AND status = 'active' AND w9_received_at IS NULL`,
      )
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(missing?.n).toBe(1);

    await recordAwardDocument(db, ctx(), admin, s.awardId, 'w9', nowIso());
    const after = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM awards
          WHERE id = ? AND status = 'active' AND w9_received_at IS NULL`,
      )
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});


describe('what is outstanding on one award', () => {
  /*
   * WHY THIS EXISTS. The three document columns have been on `awards` since
   * 0012 and nothing could write them; the data health screen has been
   * checking active awards for a missing W-9 against columns no screen could
   * fill. CLAUDE.md puts the W-9 and the media release at acceptance
   * deliberately -- "collecting tax documents from 300 applicants to fund 50
   * is waste and unnecessary custody of sensitive documents" -- which only
   * works if there is somewhere to record them arriving.
   */

  it('lists all three, and counts what is missing', async () => {
    const s = await offered();
    const before = await awardPaperwork(db, admin, s.awardId);
    expect(before.documents.map((d) => d.key)).toEqual(['w9', 'agreement', 'media_release']);
    expect(before.outstanding).toBe(3);
    expect(before.documents.every((d) => d.receivedAt === null)).toBe(true);

    await recordAwardDocument(db, ctx(), admin, s.awardId, 'w9', nowIso());
    const after = await awardPaperwork(db, admin, s.awardId);
    expect(after.outstanding).toBe(2);
    expect(after.documents.find((d) => d.key === 'w9')?.receivedAt).not.toBeNull();
  });

  it('says how much is scheduled against it, which is the sentence that matters', async () => {
    /*
     * Not a refusal. Steward does not disburse money and the Foundation's own
     * order of operations is its to run -- but somebody about to record a
     * payment should be able to see that $25,000 is scheduled against an
     * award with no signed agreement, and nothing could say so.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 1_000_000,
      scheduledDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    const paper = await awardPaperwork(db, admin, s.awardId);
    expect(paper.scheduledCents).toBe(1_000_000);
    expect(paper.outstanding).toBe(3);
    expect(paper.acceptedAt).not.toBeNull();
  });

  it('does not count a cancelled payment as money scheduled', async () => {
    /*
     * A REFUSED AWARD MUST NOT READ AS "money scheduled against incomplete
     * paperwork" forever, for a grant nobody took. `declineAward` cancels the
     * scheduled payments; this proves the paperwork view agrees with that
     * rather than summing every row on the award.
     *
     * The payment is scheduled BEFORE the refusal on purpose. An earlier
     * version of this test declined an award with no payments on it at all,
     * so it passed with the status filter removed -- a vacuous assertion that
     * a mutant caught.
     */
    const s = await offered();
    await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 500_000,
      scheduledDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect((await awardPaperwork(db, admin, s.awardId)).scheduledCents).toBe(500_000);

    await declineAward(db, ctx(), s.grantee, s.awardId, 'Our other funding fell through.');
    const paper = await awardPaperwork(db, admin, s.awardId);
    expect(paper.scheduledCents).toBe(0);
    expect(paper.declinedByGranteeAt).not.toBeNull();
    expect(paper.granteeResponseNote).toContain('other funding');
  });

  it('refuses everyone but an admin', async () => {
    // Receipt of a grantee's W-9 is the Foundation's own record, and a
    // reviewer has no business with an award's paperwork at all.
    const s = await offered();
    expect((await appErrorFrom(awardPaperwork(db, reviewerSession(newId()), s.awardId))).code)
      .toBe('NOT_FOUND');
    expect((await appErrorFrom(awardPaperwork(db, s.grantee, s.awardId))).code)
      .toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('amending an award', () => {
  /*
   * WHY THIS EXISTS. 0012 refuses to let an awarded amount be updated,
   * pointing at an amendments table Phase 4 never built -- so an award
   * recorded at the wrong amount could not be corrected through this system in
   * any way, and the documented remedy amounted to editing the production
   * database by hand. CLAUDE.md's Module 3 asks for "amendments tracked, never
   * overwritten".
   */

  it('changes the amount and writes one amendment row per field', async () => {
    const s = await offered();
    const r = await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_800_000,
      termEnd: '2027-06-30T12:00:00.000Z',
      reason: 'The partner site withdrew; the committee revised it on 14 March.',
    });
    expect(r.changed.sort()).toEqual(['awarded_amount_cents', 'term_end']);

    const award = await db
      .prepare(`SELECT awarded_amount_cents AS c, term_end AS e FROM awards WHERE id=?`)
      .bind(s.awardId)
      .first<{ c: number; e: string }>();
    expect(award?.c).toBe(1_800_000);
    expect(award?.e).toBe('2027-06-30T12:00:00.000Z');

    const history = await amendmentHistory(db, admin, s.awardId);
    expect(history.length).toBe(2);
    const money = history.find((h) => h.fieldChanged === 'awarded_amount_cents')!;
    // CENTS AS A STRING, never formatted: a record that says "$18,000" cannot
    // be compared with the column it came from.
    expect(money.oldValue).toBe('2500000');
    expect(money.newValue).toBe('1800000');
    expect(money.reason).toContain('partner site withdrew');
    expect(history.every((h) => h.amendedBy.includes('@'))).toBe(true);
  });

  it('writes an audit row as well, because the two answer different questions', async () => {
    const s = await offered();
    await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_800_000,
      reason: 'Revised by the committee.',
    });
    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action='award.amended' AND entity_id=?`,
      )
      .bind(s.awardId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('will not let the amount move without an amendment, whatever the caller does', async () => {
    /*
     * THE GUARANTEE, and the reason this is a trigger rather than a convention.
     * 0024 lets the column move only when a matching amendment row exists
     * stamped at the same instant. A hand-written UPDATE -- an import, a
     * repair, a future function that forgets -- is refused by the database.
     */
    const s = await offered();
    await expect(
      db
        .prepare(`UPDATE awards SET awarded_amount_cents = ?, updated_at = ? WHERE id = ?`)
        .bind(999, nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow(/amendment, not an update/);

    await expect(
      db
        .prepare(`UPDATE awards SET term_end = ?, updated_at = ? WHERE id = ?`)
        .bind('2030-01-01T00:00:00.000Z', nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow(/amendment, not an update/);
  });

  it('will not reuse an old amendment row to wave a later change through', async () => {
    // The amendment must be stamped at the same instant as the update, so a
    // change recorded last month cannot authorise one made today.
    const s = await offered();
    await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_800_000,
      reason: 'Revised by the committee.',
    });
    await expect(
      db
        .prepare(`UPDATE awards SET awarded_amount_cents = ?, updated_at = ? WHERE id = ?`)
        .bind(2_500_000, nowIso(), s.awardId)
        .run(),
    ).rejects.toThrow(/amendment, not an update/);
  });

  it('refuses to cut an award below what has already been paid', async () => {
    /*
     * Finance has moved that money. An award for less than was disbursed is a
     * reconciliation problem the moment it is written, and the number to fix
     * is not this one.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    const pay = await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 2_000_000,
      scheduledDate: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await recordPayment(db, ctx(), admin, pay.id, {
      paidDate: new Date().toISOString(),
      referenceNumber: 'CHQ-1001',
    });

    const err = await appErrorFrom(
      amendAward(db, ctx(), admin, s.awardId, {
        awardedAmountCents: 1_000_000,
        reason: 'Trying to cut it below what went out.',
      }),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/already been paid/i);
  });

  it('DOES allow cutting it below what is merely scheduled', async () => {
    /*
     * A reduced award with an over-committed schedule is exactly the situation
     * an amendment exists to start. Refusing would force somebody to cancel
     * payments before recording the fact that prompted it.
     */
    const s = await offered();
    await acceptAward(db, ctx(), s.grantee, s.awardId, { attestationText: ATTESTATION });
    await schedulePayment(db, ctx(), admin, s.awardId, {
      amountCents: 2_000_000,
      scheduledDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const r = await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_000_000,
      reason: 'Reduced; the schedule needs rebuilding.',
    });
    expect(r.changed).toEqual(['awarded_amount_cents']);
  });

  it('refuses an amendment that changes nothing', async () => {
    const s = await offered();
    expect(
      (await appErrorFrom(
        amendAward(db, ctx(), admin, s.awardId, {
          awardedAmountCents: 2_500_000,
          reason: 'No change at all.',
        }),
      )).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses one with no reason', async () => {
    const s = await offered();
    expect(
      (await appErrorFrom(
        amendAward(db, ctx(), admin, s.awardId, { awardedAmountCents: 1_000, reason: '  ' }),
      )).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses to amend a cancelled award', async () => {
    // That grant did not happen; changing its terms produces a record of a
    // commitment nobody made.
    const s = await offered();
    await declineAward(db, ctx(), s.grantee, s.awardId, 'We could not take it on.');
    expect(
      (await appErrorFrom(
        amendAward(db, ctx(), admin, s.awardId, {
          awardedAmountCents: 1_000_000,
          reason: 'Trying anyway.',
        }),
      )).code,
    ).toBe('CONFLICT');
  });

  it('refuses a term that ends before it starts', async () => {
    const s = await offered();
    const err = await appErrorFrom(
      amendAward(db, ctx(), admin, s.awardId, {
        termStart: '2027-06-01T00:00:00.000Z',
        termEnd: '2027-01-01T00:00:00.000Z',
        reason: 'Typo in the dates.',
      }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.publicMessage).toMatch(/end before it starts/i);
  });

  it('refuses a stale write rather than quietly dropping the other change', async () => {
    /*
     * CLAUDE.md names this as a known gap: "Two admins on one award produces
     * last-write-wins unless optimistic locking is built deliberately." Two
     * people working a decision week from the same spreadsheet is not
     * hypothetical, and last-write-wins on an award amount means one of them
     * believes a number that is not in the database.
     */
    const s = await offered();
    const stale = (
      await db.prepare(`SELECT updated_at AS u FROM awards WHERE id=?`).bind(s.awardId)
        .first<{ u: string }>()
    )!.u;

    await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_800_000,
      reason: 'The first admin got there first.',
    });

    const err = await appErrorFrom(
      amendAward(db, ctx(), admin, s.awardId, {
        awardedAmountCents: 2_200_000,
        reason: 'The second admin, working from a stale screen.',
        expectedUpdatedAt: stale,
      }),
    );
    expect(err.code).toBe('CONFLICT');
    /*
     * THE EXACT WORDING, because there are two layers here and a loose match
     * cannot tell them apart. The pre-flight comparison says "Reload and look
     * at it again"; the UPDATE's own `AND updated_at = ?` predicate, which
     * catches a change landing between the read and the write, says "Somebody
     * else changed this award first." A regex matching both passed with the
     * pre-flight check deleted -- a mutant proved it -- and so reported
     * nothing about the layer this test is named for.
     */
    expect(err.publicMessage).toMatch(/Reload and look at it again/);

    // And the first admin's number survived.
    const award = await db
      .prepare(`SELECT awarded_amount_cents AS c FROM awards WHERE id=?`)
      .bind(s.awardId)
      .first<{ c: number }>();
    expect(award?.c).toBe(1_800_000);
  });

  it('refuses everyone but an admin', async () => {
    const s = await offered();
    for (const who of [reviewerSession(newId()), s.grantee]) {
      expect(
        (await appErrorFrom(
          amendAward(db, ctx(), who, s.awardId, {
            awardedAmountCents: 1, reason: 'Not mine to change.',
          }),
        )).code,
      ).toBe('NOT_FOUND');
    }
    expect((await appErrorFrom(amendmentHistory(db, s.grantee, s.awardId))).code)
      .toBe('NOT_FOUND');
  });

  it('keeps the history append-only', async () => {
    // An amendment history that can be rewritten answers nothing, and these
    // describe money.
    const s = await offered();
    await amendAward(db, ctx(), admin, s.awardId, {
      awardedAmountCents: 1_800_000,
      reason: 'Revised by the committee.',
    });
    const one = (await amendmentHistory(db, admin, s.awardId))[0]!;
    await expect(
      db.prepare(`UPDATE award_amendments SET new_value='1' WHERE id=?`).bind(one.id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM award_amendments WHERE id=?`).bind(one.id).run(),
    ).rejects.toThrow(/append-only/);
  });
});
