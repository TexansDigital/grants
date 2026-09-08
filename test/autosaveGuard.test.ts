import { describe, it, expect } from 'vitest';
import { db, ctxFor, applicantSession, adminSession } from './helpers';
import { saveDraft } from '../src/lib/submit';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';

/** The V1 regression: an autosave that saves nothing must not claim it saved. */
async function scene() {
  const ctx = ctxFor(adminSession());
  const p = await seedProgram(db, ctx, INSPIRE_CHANGE);
  const org = (await seedOrganization(db, ctx, ORG_FIXTURES[0]!)).organizationId;
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?)`,
    )
    .bind(id, Object.values(p.cycleIds)[0]!, p.stageIds.application!, org,
          p.formDefinitionIds.application!, now, now)
    .run();
  return { id, org, session: applicantSession(org) };
}

async function auditCount(applicationId: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'application.answer_saved'`)
    .bind(applicationId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe('autosave never claims a save that did not happen', () => {
  it('saves normally while the application is a draft', async () => {
    const s = await scene();
    const r = await saveDraft(db, ctxFor(s.session), s.session, s.id, { contact_first_name: 'Dana' });
    expect(r.savedAt).toBeTruthy();
    expect(await auditCount(s.id)).toBe(1);
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM application_answers WHERE application_id = ?`)
      .bind(s.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('THROWS, and writes NO audit row, when the status flips INSIDE the window', async () => {
    /*
     * The real bug is a time-of-check/time-of-use gap, and testing it needs the
     * flip to land inside it.
     *
     * saveDraft reads the status and rejects a non-draft up front, so simply
     * submitting the application first exercises THAT check and never reaches
     * the batch -- my first attempt at this test passed with the fix removed,
     * which is a test that proves nothing. This proxy flips the status at the
     * exact moment `batch` is called: after the status read, before the
     * statements run. That is the window a concurrent submit actually occupies.
     */
    const s = await scene();
    let flipped = false;
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        if (!flipped) {
          flipped = true;
          await db
            .prepare(`UPDATE applications SET status='submitted', submitted_at=? WHERE id=?`)
            .bind(nowIso(), s.id)
            .run();
        }
        return db.batch(stmts);
      },
    } as unknown as D1Database;

    await expect(
      saveDraft(racing, ctxFor(s.session), s.session, s.id, { contact_first_name: 'Dana' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The whole point: no answers, and NO audit row claiming a save happened.
    expect(await auditCount(s.id)).toBe(0);
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM application_answers WHERE application_id = ?`)
      .bind(s.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
