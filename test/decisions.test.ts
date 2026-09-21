/**
 * Recording what the Foundation decided.
 *
 * THE HINGE OF THE SYSTEM. A decision ends scoring, starts the retention clock
 * on the applicant's financial documents, and is what an award is later made
 * against. Everything here is about making it deliberate: one decision per
 * application, only by an admin, only on something actually submitted, and a
 * decline that cannot be recorded without saying why.
 *
 * AND ABOUT WHAT IT MUST NOT DO. It records. It creates no award, schedules no
 * payment, and sends nothing. CLAUDE.md requires that a decline email is never
 * sent automatically; the cheapest way to keep that true is for this path to
 * have no way to send anything at all, and the test below is what notices if
 * that changes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { getApplicationForExternal } from '../src/lib/scope';
import type { Session } from '../src/types';

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
    .bind(id, `dec-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

async function application(opts: { submitted?: boolean } = { submitted: true }) {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `dec-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Society ${n}`, String(970000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(
      applicationId, cycleId, orgId,
      opts.submitted ? 'submitted' : 'draft',
      opts.submitted ? now : null,
      now, now, p.formDefinitionIds.application!,
    )
    .run();
  return { applicationId, orgId };
}

// ---------------------------------------------------------------------------

describe('who decides', () => {
  it('records the decision with who made it and when', async () => {
    const { applicationId } = await application();
    const result = await decideApplication(db, ctx(), admin, applicationId, {
      status: 'awarded', notes: 'Strongest fit with the focus area.',
    });
    expect(result.status).toBe('awarded');
    expect(result.decidedBy).toBe(admin.userId);

    const row = await db
      .prepare(
        `SELECT status, decided_at, decided_by, decision_notes FROM applications WHERE id = ?`,
      )
      .bind(applicationId)
      .first<{ status: string; decided_at: string; decided_by: string; decision_notes: string }>();
    expect(row?.status).toBe('awarded');
    expect(row?.decided_by).toBe(admin.userId);
    expect(typeof row?.decided_at).toBe('string');
  });

  it('refuses a reviewer', async () => {
    // A reviewer scores; they do not decide. The route says ADMIN_ONLY and
    // this refuses independently, because a function that writes decided_by is
    // one somebody will reuse from a less careful handler.
    const { applicationId } = await application();
    const reviewer = reviewerSession(newId());
    expect(
      (await appErrorFrom(
        decideApplication(db, ctx(), reviewer, applicationId, { status: 'awarded' }),
      )).code,
    ).toBe('NOT_FOUND');
  });
});

describe('what cannot be decided', () => {
  it('refuses a second decision rather than overwriting the first', async () => {
    /*
     * Not idempotent-and-silent. A second decision is either a double-click or
     * one person overwriting a colleague's call, and both deserve to be told.
     */
    const { applicationId } = await application();
    await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });
    const err = await appErrorFrom(
      decideApplication(db, ctx(), admin, applicationId, {
        status: 'declined', notes: 'changed my mind',
      }),
    );
    expect(err.code).toBe('CONFLICT');

    const row = await db
      .prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(applicationId)
      .first<{ status: string }>();
    expect(row?.status).toBe('awarded');
  });

  it('refuses a draft', async () => {
    // Recording an outcome for something nobody finished sending is always a
    // mistaken id.
    const { applicationId } = await application({ submitted: false });
    expect(
      (await appErrorFrom(
        decideApplication(db, ctx(), admin, applicationId, { status: 'declined', notes: 'x' }),
      )).code,
    ).toBe('CONFLICT');
  });

  it('refuses a status that is not a decision', async () => {
    // `under_review` is a pipeline state, and 0004 does not require decided_at
    // for it. Moving an application into review is not this function's job.
    const { applicationId } = await application();
    for (const bad of ['under_review', 'submitted', 'draft', '']) {
      expect(
        (await appErrorFrom(
          decideApplication(db, ctx(), admin, applicationId, {
            status: bad as 'awarded', notes: 'x',
          }),
        )).code,
      ).toBe('VALIDATION_FAILED');
    }
  });

  it('404s for an application that does not exist', async () => {
    expect(
      (await appErrorFrom(
        decideApplication(db, ctx(), admin, newId(), { status: 'awarded' }),
      )).code,
    ).toBe('NOT_FOUND');
  });
});

describe('a decline has to say why', () => {
  it('refuses a decline with no rationale, or with whitespace', async () => {
    /*
     * 250 declines go out in a week and one of them gets screenshotted.
     * Whoever writes that letter needs to know why, months later, and "no
     * reason recorded" is how a decline ends up saying nothing true.
     */
    const { applicationId } = await application();
    for (const bad of [undefined, null, '', '   ']) {
      const err = await appErrorFrom(
        decideApplication(db, ctx(), admin, applicationId, { status: 'declined', notes: bad }),
      );
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.fieldErrors?.[0]?.field).toBe('notes');
    }
  });

  it('does not require one for an award or a withdrawal', async () => {
    const a = await application();
    await decideApplication(db, ctx(), admin, a.applicationId, { status: 'awarded' });
    const b = await application();
    await decideApplication(db, ctx(), admin, b.applicationId, { status: 'withdrawn' });
  });
});

describe('the record it leaves', () => {
  it('puts the rationale in the audit log as well as on the row', async () => {
    // audit_log is append-only and internal; decision_notes on the row can in
    // principle be edited, and why a nonprofit was declined should survive
    // that.
    const { applicationId } = await application();
    await decideApplication(db, ctx(), admin, applicationId, {
      status: 'declined', notes: 'Requested amount exceeded the cycle ceiling.',
    });
    const row = await db
      .prepare(
        `SELECT before_json, after_json FROM audit_log
          WHERE action = 'application.decided' AND entity_id = ?`,
      )
      .bind(applicationId)
      .first<{ before_json: string; after_json: string }>();
    const before = JSON.parse(row!.before_json) as Record<string, unknown>;
    const after = JSON.parse(row!.after_json) as Record<string, unknown>;
    expect(before.status).toBe('submitted');
    expect(after.decision_notes).toBe('Requested amount exceeded the cycle ceiling.');
    expect(after.decided_by).toBe(admin.userId);
  });

  it('never shows the applicant why they were declined', async () => {
    /*
     * NON-NEGOTIABLE 5. Decision rationale is ABSENT from an applicant
     * payload, not hidden in the UI. This is the moment that rule is most
     * likely to be broken, because the rationale has just been written and the
     * applicant is about to ask.
     */
    const { applicationId, orgId } = await application();
    await decideApplication(db, ctx(), admin, applicationId, {
      status: 'declined', notes: 'Board felt the outcomes were not measurable.',
    });
    const applicant: Session = {
      userId: newId(), email: 'a@example.org', role: 'applicant', organizationId: orgId,
    };
    const payload = await getApplicationForExternal(db, applicant, applicationId);
    const asSent = JSON.stringify(payload);
    expect(asSent).not.toContain('not measurable');
    expect(asSent).not.toContain('decision_notes');
    expect(asSent).not.toContain('decided_by');
  });

  it('creates no award and schedules no payment', async () => {
    /*
     * A DECISION IS NOT AN AWARD. Not every declared intent survives
     * acceptance: a grantee may decline, or the terms may change. And
     * CLAUDE.md puts W-9 and the media release at acceptance rather than
     * application, which cannot be true if an award springs into existence
     * here.
     */
    const { applicationId } = await application();
    await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });
    const awards = await db
      .prepare(`SELECT COUNT(*) AS n FROM awards WHERE application_id = ?`)
      .bind(applicationId)
      .first<{ n: number }>();
    expect(awards?.n).toBe(0);
  });

  it('sends nothing', async () => {
    // Decline emails are never sent automatically. A message row appearing
    // here would mean this path grew a send.
    const { applicationId } = await application();
    const before = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages`)
      .first<{ n: number }>();
    await decideApplication(db, ctx(), admin, applicationId, {
      status: 'declined', notes: 'Outside the focus area.',
    });
    const after = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages`)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
