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
import { db, ctxFor, adminSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision, budgetByProgram } from '../src/lib/awards';
import {
  awardsAwaitingResponse, acceptAward, declineAward, recordAwardDocument,
} from '../src/lib/acceptance';
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
