/**
 * The public list of who was funded.
 *
 * WHAT IS AT RISK. Not the fields -- who, for what, how much is what every
 * funder publishes. The risk is TIMING. An award on a public web page before
 * the grantee has been told, or before the coordinated announcement date, is
 * the failure the whole decision-communication design was shaped around, and
 * worse here: a page is public to everyone at once rather than to one mailbox.
 *
 * Every test below is about a row that must NOT appear yet.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { decideApplication } from '../src/lib/decisions';
import { createAwardFromDecision } from '../src/lib/awards';
import { recordManualCommunication } from '../src/lib/decisionComms';
import { publicGrants, publishableAwards, setAwardPublic } from '../src/lib/publicGrants';
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
    .bind(id, `pub-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

const ctx = () => ctxFor(admin);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();

async function funded(opts: { announce?: string | null; told?: boolean } = {}) {
  const p = await seedProgram(db, ctx(), { ...INSPIRE_CHANGE, slug: `pub-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const now = nowIso();
  const name = `Invented Foundation ${n}`;

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, name, String(990000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, project_title, primary_contact_email, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(
      applicationId, cycleId, orgId, now, `Reading programme ${n}`,
      `contact${n}@example.org`, now, now, p.formDefinitionIds.application!,
    )
    .run();
  await decideApplication(db, ctx(), admin, applicationId, { status: 'awarded' });
  const award = await createAwardFromDecision(db, ctx(), admin, applicationId, {
    awardedAmountCents: 2_500_000,
    announcementDate: opts.announce ?? null,
  });
  if (opts.told !== false) {
    await recordManualCommunication(db, ctx(), admin, applicationId, 'Called them.');
  }
  return { cycleId, orgId, applicationId, awardId: award.awardId, name };
}

const names = async () => (await publicGrants(db, nowIso())).map((g) => g.organizationName);

// ---------------------------------------------------------------------------

describe('nothing is published by default', () => {
  it('shows an award only once an admin has marked it public', async () => {
    // 0012's own comment on the column: publishing another organization's
    // grant is an opt-in, never a default. This is the first code to honour it.
    const a = await funded();
    expect(await names()).not.toContain(a.name);

    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    expect(await names()).toContain(a.name);
  });

  it('takes it back down again', async () => {
    const a = await funded();
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    await setAwardPublic(db, ctx(), admin, a.awardId, false);
    expect(await names()).not.toContain(a.name);
  });
});

describe('what must not appear yet', () => {
  it('hides an award whose grantee has not been told', async () => {
    /*
     * THE FAILURE THIS PREVENTS. A nonprofit learning it was funded from a
     * public web page, before the letter. Worse than the portal version of
     * this bug, because a page is public to everyone at once.
     */
    const a = await funded({ told: false });
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    expect(await names()).not.toContain(a.name);

    await recordManualCommunication(db, ctx(), admin, a.applicationId, 'Called them.');
    expect(await names()).toContain(a.name);
  });

  it('respects the embargo date, and lifts it when it passes', async () => {
    /*
     * announcement_date is a separate fact from the decision for exactly this.
     * Marking an award public BEFORE the embargo lifts is ordinary preparation
     * for an announcement -- the flag is allowed, and the page simply does not
     * show it yet.
     */
    const a = await funded({ announce: day(30) });
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    expect(await names()).not.toContain(a.name);

    await db
      .prepare(`UPDATE awards SET announcement_date = ? WHERE id = ?`)
      .bind(day(-1), a.awardId)
      .run();
    expect(await names()).toContain(a.name);
  });

  it('shows an award with no embargo date immediately', async () => {
    // No announcement date is no embargo to wait for, not an indefinite one.
    const a = await funded({ announce: null });
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    expect(await names()).toContain(a.name);
  });

  it('hides a cancelled award even when it is marked public', async () => {
    // A grant that was rescinded or refused is not one the Foundation made.
    const a = await funded();
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    await db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).bind(a.awardId).run();
    expect(await names()).not.toContain(a.name);
  });

  it('cannot have its organization removed out from under it', async () => {
    /*
     * The query guards on `o.deleted_at IS NULL`, and this test is what says
     * that guard is DEFENCE IN DEPTH rather than a live condition: the schema
     * refuses to soft-delete an organization that still holds an award, so the
     * state the guard protects against cannot currently be reached.
     *
     * Written this way rather than deleted, because the guard should not be
     * removed as dead code -- the trigger is the thing holding it, and triggers
     * get relaxed.
     */
    const a = await funded();
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    await expect(
      db
        .prepare(`UPDATE organizations SET deleted_at = ? WHERE id = ?`)
        .bind(nowIso(), a.orgId)
        .run(),
    ).rejects.toThrow();
    expect(await names()).toContain(a.name);
  });

  it('hides an award whose application was removed', async () => {
    // The reachable half of the same guard: an application can be put away
    // while its award stands, and a published row built on a removed
    // application is one nobody can trace back.
    const a = await funded();
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    await db
      .prepare(`UPDATE applications SET deleted_at = ? WHERE id = ?`)
      .bind(nowIso(), a.applicationId)
      .run();
    expect(await names()).not.toContain(a.name);
  });
});

describe('what the page carries', () => {
  it('has who, for what and how much, and nothing else', async () => {
    /*
     * An organization that applied for a grant did not consent to its
     * APPLICATION being published. The private fields are not filtered out of
     * a wider query -- they are never selected -- and this asserts the shape
     * that reaches the wire.
     */
    const a = await funded();
    await setAwardPublic(db, ctx(), admin, a.awardId, true);
    const grant = (await publicGrants(db, nowIso())).find((g) => g.organizationName === a.name)!;

    expect(grant.awardedAmountCents).toBe(2_500_000);
    expect(grant.projectTitle).toMatch(/^Reading programme/);
    expect(grant.awardedYear).toMatch(/^\d{4}$/);

    const asSent = JSON.stringify(grant);
    for (const forbidden of [
      'ein', 'primary_contact_email', 'contact', 'decision_notes', 'internal_notes',
      'score', 'submission_ip', 'application_id', 'organizationId',
    ]) {
      expect(asSent, `public payload carries ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the admin view', () => {
  it('lists what cannot be published, with the reason', async () => {
    /*
     * An admin who marks an award public and then cannot find it on the page
     * will assume the feature is broken. Being told "the grantee has not been
     * told yet" is the difference between a rule and a bug.
     */
    const untold = await funded({ told: false });
    const rows = await publishableAwards(db, admin, untold.cycleId, nowIso());
    expect(rows[0]!.blockedBecause).toMatch(/not been told/i);

    const embargoed = await funded({ announce: day(30) });
    const e = await publishableAwards(db, admin, embargoed.cycleId, nowIso());
    expect(e[0]!.blockedBecause).toMatch(/Embargoed until/);

    const ready = await funded();
    const r = await publishableAwards(db, admin, ready.cycleId, nowIso());
    expect(r[0]!.blockedBecause).toBeNull();
  });

  it('refuses a reviewer', async () => {
    const a = await funded();
    const reviewer = reviewerSession(newId());
    expect((await appErrorFrom(publishableAwards(db, reviewer, a.cycleId, nowIso()))).code)
      .toBe('NOT_FOUND');
    expect((await appErrorFrom(setAwardPublic(db, ctx(), reviewer, a.awardId, true))).code)
      .toBe('NOT_FOUND');
  });

  it('refuses to publish an imported award with no application', async () => {
    /*
     * There is no communication stamp to check, so the page's condition cannot
     * be evaluated. Refusing the flag with a reason beats setting it and
     * having the award silently never appear.
     */
    const a = await funded();
    const orphanId = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id,
           awarded_amount_cents, awarded_at, status, source_system, source_reference,
           created_at, updated_at)
         SELECT ?, NULL, w.organization_id, w.program_id, 100000, ?, 'active',
                'spreadsheet', ?, ?, ?
           FROM awards w WHERE w.id = ?`,
      )
      .bind(orphanId, now, `legacy-${n}`, now, now, a.awardId)
      .run();

    const err = await appErrorFrom(setAwardPublic(db, ctx(), admin, orphanId, true));
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/imported/i);
  });
});
