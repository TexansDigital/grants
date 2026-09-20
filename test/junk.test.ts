/**
 * Removing what should not be there.
 *
 * THE DECISION THIS SERVES. Registration is open — anybody may complete the
 * eligibility screen and become an organization — and the Foundation clears
 * out the fakes afterwards. Workable, and not workable at all without a way to
 * clear anything out.
 *
 * So the tests are mostly about what must NOT be removable, because that is
 * where this does damage. A nonprofit that submitted an hour of work, or that
 * was given money, is not junk, and a button that removes them on a busy
 * afternoon is worse than no button.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import {
  junkOrganization,
  restoreOrganization,
  junkApplication,
  listRemovedOrganizations,
  organizationJunkBlocker,
} from '../src/lib/junk';
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
    .bind(id, `junk-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);

async function org(name = 'Invented Applicant'): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?, 'active', ?, ?)`,
    )
    .bind(id, `${name} ${++n}`, String(600000000 + n), now, now)
    .run();
  return id;
}

async function applicationFor(
  organizationId: string,
  opts: { submitted?: boolean; decided?: boolean } = {},
): Promise<{ applicationId: string; programId: string }> {
  const program = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `junk-${++n}` });
  const cycleId = (await db
    .prepare(`SELECT id FROM cycles WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;
  const stageId = (await db
    .prepare(`SELECT id FROM program_stages WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;
  const formId = (await db
    .prepare(`SELECT id FROM form_definitions WHERE program_id=? LIMIT 1`)
    .bind(program.programId)
    .first<{ id: string }>())!.id;

  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, decided_at, decided_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id, cycleId, stageId, organizationId, formId,
      opts.submitted ? 'submitted' : 'draft',
      opts.submitted ? now : null,
      // 0004 CHECKs that decided_at and decided_by are set together. A decision
      // with no decider is a gap exactly where somebody will ask who decided.
      opts.decided ? now : null,
      opts.decided ? admin.userId : null,
      now, now,
    )
    .run();
  return { applicationId: id, programId: program.programId };
}

// ---------------------------------------------------------------------------

describe('what must not be removable', () => {
  it('refuses an organization holding an award', async () => {
    const organizationId = await org('Funded');
    const { applicationId, programId } = await applicationFor(organizationId, { submitted: true });
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id,
           awarded_amount_cents, awarded_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .bind(newId(), applicationId, organizationId, programId, 500000, now, now, now)
      .run();

    const blocker = await organizationJunkBlocker(db, organizationId);
    expect(blocker).not.toBeNull();
    expect(blocker!.awards).toBe(1);
    await expect(junkOrganization(db, ctx(), admin, organizationId, 'looks fake')).rejects.toThrow();
  });

  it('refuses an organization that has submitted an application', async () => {
    // Somebody spent an hour on that. Whatever it looks like, it is not junk.
    const organizationId = await org('Submitted');
    await applicationFor(organizationId, { submitted: true });

    const blocker = await organizationJunkBlocker(db, organizationId);
    expect(blocker!.submittedApplications).toBe(1);
    await expect(junkOrganization(db, ctx(), admin, organizationId, 'spam')).rejects.toThrow();
  });

  it('refuses a decided application', async () => {
    // The application is the evidence for the decision. Remove it and an award
    // or a decline has nothing behind it.
    const organizationId = await org('Decided');
    const { applicationId } = await applicationFor(organizationId, {
      submitted: true,
      decided: true,
    });
    await expect(junkApplication(db, ctx(), admin, applicationId, 'duplicate')).rejects.toThrow();
  });

  it('refuses a removal with no reason', async () => {
    const organizationId = await org('Nameless');
    await expect(junkOrganization(db, ctx(), admin, organizationId, '  ')).rejects.toThrow();
  });
});

describe('removing junk', () => {
  it('soft-deletes with a reason, takes the drafts, and deactivates the sign-in', async () => {
    const organizationId = await org('Obvious Junk');
    await applicationFor(organizationId); // a draft
    const userId = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
      )
      .bind(userId, `junk-${++n}@example.org`, organizationId, now, now)
      .run();

    const result = await junkOrganization(db, ctx(), admin, organizationId, 'Obvious test entry');
    expect(result.applications).toBe(1);
    expect(result.users).toBe(1);

    const o = await db
      .prepare(`SELECT deleted_at, deleted_reason FROM organizations WHERE id=?`)
      .bind(organizationId)
      .first<{ deleted_at: string; deleted_reason: string }>();
    expect(o?.deleted_at).not.toBeNull();
    expect(o?.deleted_reason).toBe('Obvious test entry');

    // Nothing is hard-deleted, so the row is still there to be found.
    const stillThere = await db
      .prepare(`SELECT COUNT(*) AS n FROM organizations WHERE id=?`)
      .bind(organizationId)
      .first<{ n: number }>();
    expect(stillThere?.n).toBe(1);

    const u = await db
      .prepare(`SELECT is_active FROM users WHERE id=?`)
      .bind(userId)
      .first<{ is_active: number }>();
    expect(u?.is_active).toBe(0);

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action='organization.removed' AND entity_id=?`,
      )
      .bind(organizationId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('removes one application without touching its organization', async () => {
    const organizationId = await org('Real But Duplicated');
    const { applicationId } = await applicationFor(organizationId);
    await junkApplication(db, ctx(), admin, applicationId, 'Applied to the wrong program');

    const a = await db
      .prepare(`SELECT deleted_at, deleted_reason FROM applications WHERE id=?`)
      .bind(applicationId)
      .first<{ deleted_at: string; deleted_reason: string }>();
    expect(a?.deleted_reason).toBe('Applied to the wrong program');

    const o = await db
      .prepare(`SELECT deleted_at FROM organizations WHERE id=?`)
      .bind(organizationId)
      .first<{ deleted_at: string | null }>();
    expect(o?.deleted_at).toBeNull();
  });
});

describe('undoing it', () => {
  it('restores the organization and the drafts that went with it', async () => {
    const organizationId = await org('Wrongly Removed');
    const { applicationId } = await applicationFor(organizationId);
    await junkOrganization(db, ctx(), admin, organizationId, 'Thought it was a test');
    await restoreOrganization(db, ctx(), admin, organizationId);

    const o = await db
      .prepare(`SELECT deleted_at, deleted_reason FROM organizations WHERE id=?`)
      .bind(organizationId)
      .first<{ deleted_at: string | null; deleted_reason: string | null }>();
    expect(o?.deleted_at).toBeNull();
    expect(o?.deleted_reason).toBeNull();

    const a = await db
      .prepare(`SELECT deleted_at FROM applications WHERE id=?`)
      .bind(applicationId)
      .first<{ deleted_at: string | null }>();
    expect(a?.deleted_at).toBeNull();
  });

  it('does NOT revive an application that was removed separately', async () => {
    /*
     * THE BUG THIS PREVENTS. Restoring by organization id alone would revive
     * every application ever soft-deleted for that organization, including one
     * an admin removed deliberately months earlier — and it would look like a
     * successful restore.
     *
     * So rows come back by matching the exact deleted_at stamp the removal
     * wrote, and nothing else does.
     */
    const organizationId = await org('Mixed History');
    const earlier = await applicationFor(organizationId);
    await junkApplication(db, ctx(), admin, earlier.applicationId, 'Deliberately removed in January');

    const later = await applicationFor(organizationId);
    await junkOrganization(db, ctx(), admin, organizationId, 'Removed in March');
    await restoreOrganization(db, ctx(), admin, organizationId);

    const revived = await db
      .prepare(`SELECT deleted_at, deleted_reason FROM applications WHERE id=?`)
      .bind(earlier.applicationId)
      .first<{ deleted_at: string | null; deleted_reason: string | null }>();
    expect(revived?.deleted_at).not.toBeNull();
    expect(revived?.deleted_reason).toBe('Deliberately removed in January');

    const restored = await db
      .prepare(`SELECT deleted_at FROM applications WHERE id=?`)
      .bind(later.applicationId)
      .first<{ deleted_at: string | null }>();
    expect(restored?.deleted_at).toBeNull();
  });
});

describe('finding a mistake', () => {
  it('lists what was put away, with the reason', async () => {
    // A soft delete nobody can see is a hard delete with extra steps.
    const organizationId = await org('Listed');
    await junkOrganization(db, ctx(), admin, organizationId, 'No EIN, no contact, gibberish name');

    const removed = await listRemovedOrganizations(db);
    const mine = removed.find((r) => r.id === organizationId);
    expect(mine).toBeTruthy();
    expect(mine!.deleted_reason).toBe('No EIN, no contact, gibberish name');
  });

  it('says nothing blocks a genuinely empty organization', async () => {
    const organizationId = await org('Empty');
    expect(await organizationJunkBlocker(db, organizationId)).toBeNull();
  });
});
