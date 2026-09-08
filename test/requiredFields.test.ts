import { describe, it, expect } from 'vitest';
import { db, ctxFor, applicantSession, adminSession } from './helpers';
import { saveDraft, submitApplication } from '../src/lib/submit';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { loadFormDefinition } from '../src/lib/loadForm';

describe('A1: can required fields be bypassed by blanking then submitting?', () => {
  it('submitting an application whose answers were blanked', async () => {
    const ctx = ctxFor(adminSession());
    const p = await seedProgram(db, ctx, INSPIRE_CHANGE);
    const org = (await seedOrganization(db, ctx, ORG_FIXTURES[0]!)).organizationId;
    const id = newId();
    const now = nowIso();
    const cycleId = Object.values(p.cycleIds)[0]!;
    // Open the cycle so submit is possible at all.
    await db.prepare(`UPDATE cycles SET status='open', opens_at=?, closes_at=? WHERE id=?`)
      .bind('2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', cycleId).run();
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?)`,
    ).bind(id, cycleId, p.stageIds.application!, org, p.formDefinitionIds.application!, now, now).run();

    const session = applicantSession(org);

    // Blank EVERY field the definition declares, not a hand-picked subset --
    // my first attempt missed several and validation correctly failed on those,
    // which hid whether the blanked ones were being caught.
    const def = await loadFormDefinition(db, p.formDefinitionIds.application!);
    const blanks: Record<string, unknown> = {};
    for (const f of def.sections.flatMap((sec) => sec.fields)) {
      // The attestations are checked, as any real applicant must. Everything
      // else is blanked. This is the realistic shape of the attack.
      if (f.field_type === 'checkbox_attestation' || f.field_type === 'consent_checkbox') {
        blanks[f.field_key] = true;
        continue;
      }
      blanks[f.field_key] = f.field_type === 'multi_select' || f.field_type === 'file_upload' ? [] : '';
    }
    console.log('FIELDS BLANKED:', Object.keys(blanks).length);
    const saved = await saveDraft(db, ctxFor(session), session, id, blanks);
    console.log('BLANKING AUTOSAVE errors:', saved.errors.length);

    const nullRows = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_answers
        WHERE application_id = ? AND value_text IS NULL AND value_int IS NULL
          AND value_real IS NULL AND value_json IS NULL`,
    ).bind(id).first<{ n: number }>();
    console.log('ALL-NULL ANSWER ROWS WRITTEN:', nullRows?.n);

    let outcome = 'REJECTED';
    try {
      await submitApplication(db, ctxFor(session), session, id, {});
      outcome = 'ACCEPTED';
    } catch (e: unknown) {
      outcome = `REJECTED ${(e as { code?: string }).code}`;
    }
    console.log('SUBMIT OUTCOME:', outcome);

    const app = await db.prepare(
      `SELECT status, project_title, requested_amount_cents, ein_at_submit, primary_contact_email
         FROM applications WHERE id = ?`,
    ).bind(id).first<Record<string, unknown>>();
    console.log('STORED:', JSON.stringify(app));

    // The assertion that matters: a submitted application must not have NULL money.
    expect(outcome).toContain('REJECTED');
  });
});
