import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { describeAward } from '../src/lib/awardSubject';
import { awardOverview } from '../src/lib/awardPage';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/**
 * Recording what a grant was for.
 *
 * WHY THIS EXISTS AT ALL. The compliance desk can tell you the Foundation gave
 * an organization $50,000 in 2025. Nothing could tell you what for: the award
 * importer accepts identity and dates, `awards.application_id` is NULL for
 * everything imported, and `application_fts` -- the index whose own header
 * quotes "have we ever funded youth mental health in Fort Bend County" --
 * indexes applications, of which those grants have none.
 *
 * The tests below are in the order of what they protect: that a non-admin
 * cannot write, that the audit trail is real, that two admins cannot silently
 * overwrite one another, and that this stayed OUT of the amendment trail,
 * which exists to answer "what changed about this grant's terms".
 */

const day = (s: string) => `${s}T00:00:00.000Z`;
let seq = 0;

async function org(): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(id, `Org ${++seq}`, String(870000000 + seq), now, now)
    .run();
  return id;
}

/** An award exactly as the importer writes one: no application, no cycle. */
async function importedAward(programId: string, status = 'active'): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO awards (id, application_id, organization_id, program_id,
         awarded_amount_cents, awarded_at, status, source_system, source_reference,
         created_at, updated_at)
       VALUES (?,NULL,?,?,?,?,?,'spreadsheet',?,?,?)`,
    )
    .bind(id, await org(), programId, 5_000_000, day('2025-10-01'), status,
          `IMP-${id.slice(0, 8)}`, now, now)
    .run();
  return id;
}

async function program(): Promise<string> {
  // A fresh slug per call. vitest-pool-workers isolates storage per TEST, not
  // per file, so this is belt and braces -- but a seed that collides inside
  // one test is the kind of failure that reads as a bug in the thing under
  // test rather than in its setup.
  const seeded = await seedProgram(db, ctxFor(adminSession()), {
    ...INSPIRE_CHANGE,
    slug: `aw-subject-${++seq}`,
  });
  return seeded.programId;
}

async function readBack(id: string) {
  return db
    .prepare(
      `SELECT project_title, purpose, focus_area, counties_served_json, updated_at
         FROM awards WHERE id = ?`,
    )
    .bind(id)
    .first<{
      project_title: string | null; purpose: string | null; focus_area: string | null;
      counties_served_json: string | null; updated_at: string;
    }>();
}

describe('describeAward', () => {
  /* ---- who may write ---------------------------------------------------- */

  it('refuses a reviewer with a 404, not a 403', async () => {
    const awardId = await importedAward(await program());
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), reviewerSession(), awardId, { purpose: 'Literacy coaching' }),
    );
    // A 403 would confirm the id exists. A reviewer must not be able to
    // enumerate awards by watching which ids answer differently.
    expect(err.code).toBe('NOT_FOUND');
    expect((await readBack(awardId))?.purpose).toBeNull();
  });

  it('refuses an applicant the same way', async () => {
    const awardId = await importedAward(await program());
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), applicantSession('org-not-theirs'), awardId, {
        purpose: 'Literacy coaching',
      }),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  it('answers 404 for an award that does not exist', async () => {
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), adminSession(), newId(), { purpose: 'x' }),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  /* ---- what it writes --------------------------------------------------- */

  it('records what a grant was for', async () => {
    const awardId = await importedAward(await program());
    const out = await describeAward(db, ctxFor(), adminSession(), awardId, {
      projectTitle: 'Campus literacy coaches',
      purpose: 'Two full-time coordinators across four campuses.',
      focusArea: 'Education',
      countiesServed: ['Harris', 'Fort Bend'],
    });
    expect(out.changed.sort()).toEqual(
      ['counties_served_json', 'focus_area', 'project_title', 'purpose'],
    );
    const row = await readBack(awardId);
    expect(row?.project_title).toBe('Campus literacy coaches');
    expect(row?.focus_area).toBe('Education');
    expect(JSON.parse(row!.counties_served_json!)).toEqual(['Harris', 'Fort Bend']);
  });

  it('writes an audit row, because every award write does', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Health' });
    const audit = await db
      .prepare(
        `SELECT action, before_json, after_json FROM audit_log
          WHERE entity_type = 'award' AND entity_id = ?`,
      )
      .bind(awardId)
      .first<{ action: string; before_json: string; after_json: string }>();
    expect(audit?.action).toBe('award.described');
    // Both sides recorded: a row saying only the new value cannot answer
    // "what did this say before somebody changed it".
    expect(JSON.parse(audit!.before_json)).toMatchObject({ focus_area: null });
    expect(JSON.parse(audit!.after_json)).toMatchObject({ focus_area: 'Health' });
  });

  /*
   * NOT AN AMENDMENT, and this is the test that keeps it that way. The
   * amendment trail answers "what changed about this grant's terms" -- the
   * amount, the dates. Filling in a blank description is not that, and letting
   * it into that table would make the question unanswerable.
   */
  it('leaves the amendment trail alone', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { purpose: 'Food distribution' });
    const n = await db
      .prepare(`SELECT COUNT(*) AS n FROM award_amendments WHERE award_id = ?`)
      .bind(awardId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  /* ---- present, absent and null ----------------------------------------- */

  it('leaves an omitted field alone rather than blanking it', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      purpose: 'Food distribution',
      focusArea: 'Hunger',
    });
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Food security' });
    const row = await readBack(awardId);
    expect(row?.purpose).toBe('Food distribution');
    expect(row?.focus_area).toBe('Food security');
  });

  /*
   * EVERY FIELD, not just one. The first version of this pinned present-or-
   * absent for `purpose` alone, so mutating the `focusArea` branch to blank it
   * on every save passed the whole suite. Four near-identical branches is
   * exactly the shape where one of them quietly differs.
   */
  it('leaves every omitted field alone, not just the first one', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      projectTitle: 'Campus literacy coaches',
      purpose: 'Two coordinators.',
      focusArea: 'Education',
      countiesServed: ['Harris'],
    });
    for (const [field, value] of [
      ['projectTitle', 'Reading corps'],
      ['purpose', 'Three coordinators.'],
      ['focusArea', 'Youth development'],
      ['countiesServed', ['Fort Bend']],
    ] as const) {
      await describeAward(db, ctxFor(), adminSession(), awardId, { [field]: value });
      const row = await readBack(awardId);
      // Whatever was not sent is still there.
      expect(row?.project_title).not.toBeNull();
      expect(row?.purpose).not.toBeNull();
      expect(row?.focus_area).not.toBeNull();
      expect(row?.counties_served_json).not.toBeNull();
    }
    const row = await readBack(awardId);
    expect(row?.project_title).toBe('Reading corps');
    expect(row?.purpose).toBe('Three coordinators.');
    expect(row?.focus_area).toBe('Youth development');
    expect(JSON.parse(row!.counties_served_json!)).toEqual(['Fort Bend']);
  });

  it('clears a field on an explicit null', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' });
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: null });
    expect((await readBack(awardId))?.focus_area).toBeNull();
  });

  it('treats an empty string as clearing, not as an answer', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' });
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: '   ' });
    expect((await readBack(awardId))?.focus_area).toBeNull();
  });

  it('refuses a save that would change nothing', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' });
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  /* ---- counties --------------------------------------------------------- */

  it('stores counties as the same JSON shape applications use', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      countiesServed: ['Harris', 'Montgomery'],
    });
    const row = await readBack(awardId);
    expect(row?.counties_served_json).toBe('["Harris","Montgomery"]');
  });

  it('drops a repeated county without lowercasing what somebody typed', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      countiesServed: ['Fort Bend', 'fort bend', 'Harris'],
    });
    // The first spelling survives: "fort bend" on a board report is the thing
    // a de-duplication by lowercasing would have produced.
    expect(JSON.parse((await readBack(awardId))!.counties_served_json!))
      .toEqual(['Fort Bend', 'Harris']);
  });

  it('treats an empty list as nothing recorded', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { countiesServed: ['Harris'] });
    await describeAward(db, ctxFor(), adminSession(), awardId, { countiesServed: [] });
    expect((await readBack(awardId))?.counties_served_json).toBeNull();
  });

  it('refuses something that is not a list of names', async () => {
    const awardId = await importedAward(await program());
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), adminSession(), awardId, {
        countiesServed: ['Harris', 42 as unknown as string],
      }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect((await readBack(awardId))?.counties_served_json).toBeNull();
  });

  it('refuses a paste where a one-line field was expected', async () => {
    const awardId = await importedAward(await program());
    const err = await appErrorFrom(
      describeAward(db, ctxFor(), adminSession(), awardId, { projectTitle: 'x'.repeat(201) }),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  /* ---- two admins ------------------------------------------------------- */

  it('refuses a save built on a stale read rather than overwriting silently', async () => {
    const awardId = await importedAward(await program());
    const before = (await readBack(awardId))!.updated_at;
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' });

    const err = await appErrorFrom(
      describeAward(db, ctxFor(), adminSession(), awardId, {
        focusArea: 'Education',
        expectedUpdatedAt: before,
      }),
    );
    expect(err.code).toBe('CONFLICT');
    // The first admin's work is still there.
    expect((await readBack(awardId))?.focus_area).toBe('Hunger');
  });

  it('accepts a save that carries the current token', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, { focusArea: 'Hunger' });
    const current = (await readBack(awardId))!.updated_at;
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      focusArea: 'Education',
      expectedUpdatedAt: current,
    });
    expect((await readBack(awardId))?.focus_area).toBe('Education');
  });

  /* ---- a cancelled grant is still history ------------------------------- */

  it('records the subject of a cancelled grant, where an amendment is refused', async () => {
    const awardId = await importedAward(await program(), 'cancelled');
    await describeAward(db, ctxFor(), adminSession(), awardId, { purpose: 'Rescinded, was for X' });
    expect((await readBack(awardId))?.purpose).toBe('Rescinded, was for X');
  });

  /* ---- and it reaches the page ------------------------------------------ */

  it('appears on the award page, with the counties parsed', async () => {
    const awardId = await importedAward(await program());
    await describeAward(db, ctxFor(), adminSession(), awardId, {
      projectTitle: 'Campus literacy coaches',
      focusArea: 'Education',
      countiesServed: ['Harris', 'Fort Bend'],
    });
    const page = await awardOverview(db, adminSession(), awardId);
    // The coalesced title, for display.
    expect(page.projectTitle).toBe('Campus literacy coaches');
    // And the award's own, which is what the edit form reads and writes.
    expect(page.subject.projectTitle).toBe('Campus literacy coaches');
    expect(page.subject.focusArea).toBe('Education');
    expect(page.subject.countiesServed).toEqual(['Harris', 'Fort Bend']);
    // The screen needs this to take the lock on its own save.
    expect(page.updatedAt).not.toBe('');
  });

  /*
   * THE BUG THIS PINS, which I nearly shipped. `projectTitle` on the overview
   * is a COALESCE -- the award's own title, else the application's. An edit
   * form pre-filled from that value and then saved would write the
   * APPLICATION'S title into the award's column, as though somebody had
   * decided it was what the grant funded. What a screen edits has to be what
   * it read, so the form reads `subject`, which is the award's own and
   * nothing else.
   */
  it('does not present an application`s title as the award`s own', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE,
      slug: `aw-subject-app-${++seq}`,
    });
    const orgId = await org();
    const now = nowIso();
    const cycle = await db
      .prepare(`SELECT id FROM cycles WHERE program_id = ? LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();
    const stage = await db
      .prepare(`SELECT id FROM program_stages WHERE program_id = ? ORDER BY sort_order LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();
    const form = await db
      .prepare(`SELECT id FROM form_definitions WHERE program_id = ? ORDER BY version LIMIT 1`)
      .bind(p.programId)
      .first<{ id: string }>();

    const appId = newId();
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, project_title, submitted_at, created_at, updated_at)
         VALUES (?,?,?,?,?, 'submitted', 'After-school reading', ?, ?, ?)`,
      )
      .bind(appId, cycle!.id, stage!.id, orgId, form!.id, now, now, now)
      .run();

    const awardId = newId();
    await db
      .prepare(
        `INSERT INTO awards (id, application_id, organization_id, program_id, cycle_id,
           awarded_amount_cents, awarded_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .bind(awardId, appId, orgId, p.programId, cycle!.id, 2_000_000, day('2025-10-01'), now, now)
      .run();

    const page = await awardOverview(db, adminSession(), awardId);
    // Shown, because the page should name the work.
    expect(page.projectTitle).toBe('After-school reading');
    // But not as something anybody recorded against this award.
    expect(page.subject.projectTitle).toBeNull();
  });

  it('reads as nothing recorded on an imported grant nobody has catalogued', async () => {
    const page = await awardOverview(db, adminSession(), await importedAward(await program()));
    expect(page.projectTitle).toBeNull();
    expect(page.subject.projectTitle).toBeNull();
    expect(page.subject.purpose).toBeNull();
    expect(page.subject.focusArea).toBeNull();
    expect(page.subject.countiesServed).toEqual([]);
  });
});
