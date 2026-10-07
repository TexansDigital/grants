import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { FIELD_TYPE_BY_METRIC_TYPE } from '../src/lib/reportForm';
import { metricColumnFor } from '../src/lib/reportSubmit';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { FieldDef } from '../src/lib/fieldTypes';

/**
 * Three places decide how a metric becomes a form field, and they must agree.
 *
 *   1. `FIELD_TYPE_BY_METRIC_TYPE` in reportForm.ts, which the scaffolder uses
 *      to choose a field type when it builds a report form.
 *   2. A pair of triggers in migration 0013, which REFUSE a form field whose
 *      type does not match its metric's type.
 *   3. `metricColumnFor` in reportSubmit.ts, which decides which
 *      `metric_values` column the answer lands in.
 *
 * `metricColumnFor`'s docstring says it "mirrors the trigger in 0013 and the
 * scaffolder's FIELD_TYPE_BY_METRIC_TYPE". Nothing checked that. The existing
 * test asserts FIELD_TYPE_BY_METRIC_TYPE equals a literal copy of itself,
 * which is a snapshot: change the trigger and it still passes, and the first
 * sign would be a grantee's report refused by the database at submit.
 *
 * WHY THIS TEST EXISTS AT ALL. A sibling of it, on a different pair of files,
 * shipped: 0028 asserts `awards.counties_served_json` is "the same shape as
 * `applications.counties_served_json`", and it is not -- an application stores
 * the multi_select's option VALUES. A comment claiming two modules agree is
 * worth exactly nothing, and every one of them should be a test instead.
 *
 * So this drives all three for real: the scaffolder picks, the DATABASE
 * accepts or refuses, and the submit path finds a column. No literals.
 */

const METRIC_TYPES = ['integer', 'currency', 'decimal', 'text'] as const;

describe('the three places that decide a metric field type', () => {
  it('agree, for every metric type', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE,
      slug: `metric-agree-${Date.now()}`,
    });
    const now = nowIso();

    // One form definition and section to hang the fields off.
    const formId = newId();
    const sectionId = newId();
    await db
      .prepare(
        `INSERT INTO form_definitions
           (id, program_id, stage_id, kind, form_key, name, version, status,
            created_at, updated_at)
         VALUES (?, ?, NULL, 'report', 'agreement-probe', 'Agreement probe', 99, 'draft', ?, ?)`,
      )
      .bind(formId, p.programId, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO form_sections
           (id, form_definition_id, section_key, title, sort_order, created_at)
         VALUES (?,?,'metrics','Metrics',0,?)`,
      )
      .bind(sectionId, formId, now)
      .run();

    for (const metricType of METRIC_TYPES) {
      const metricId = newId();
      await db
        .prepare(
          `INSERT INTO metric_definitions
             (id, program_id, metric_key, label, metric_type, is_required, sort_order,
              status, created_at, updated_at)
           VALUES (?,?,?,?,?,0,0,'active',?,?)`,
        )
        .bind(metricId, p.programId, `probe_${metricType}`, `Probe ${metricType}`, metricType, now, now)
        .run();

      // 1. What the scaffolder would choose.
      const fieldType = FIELD_TYPE_BY_METRIC_TYPE[metricType];
      expect(fieldType, `scaffolder has a field type for ${metricType}`).toBeTruthy();

      // 2. What the DATABASE will accept. The trigger is the authority; if it
      //    refuses, the scaffolder would produce a form that cannot be saved.
      await db
        .prepare(
          `INSERT INTO form_fields
             (id, form_definition_id, form_section_id, field_key, label, field_type,
              is_required, sort_order, metric_definition_id, created_at)
           VALUES (?,?,?,?,?,?,0,0,?,?)`,
        )
        .bind(
          newId(), formId, sectionId, `metric_probe_${metricType}`,
          `Probe ${metricType}`, fieldType, metricId, now,
        )
        .run();

      // 3. And where the answer would land. Null here means a field that got
      //    past the trigger has nowhere to be stored, which submitReport
      //    treats as a configuration error -- raised at a grantee, mid-report.
      const column = metricColumnFor({ field_type: fieldType } as FieldDef);
      expect(column, `submit path has a column for ${metricType} -> ${fieldType}`).not.toBeNull();
    }
  });

  /*
   * And the other direction: a field type the scaffolder would never choose
   * must still be refused by the database rather than quietly accepted. This
   * is what proves the trigger is doing work, rather than the test passing
   * because nothing is enforced.
   */
  it('and the database refuses a pairing the scaffolder would never make', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), {
      ...INSPIRE_CHANGE,
      slug: `metric-refuse-${Date.now()}`,
    });
    const now = nowIso();
    const formId = newId();
    const sectionId = newId();
    await db
      .prepare(
        `INSERT INTO form_definitions
           (id, program_id, stage_id, kind, form_key, name, version, status,
            created_at, updated_at)
         VALUES (?, ?, NULL, 'report', 'refusal-probe', 'Refusal probe', 98, 'draft', ?, ?)`,
      )
      .bind(formId, p.programId, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO form_sections
           (id, form_definition_id, section_key, title, sort_order, created_at)
         VALUES (?,?,'metrics','Metrics',0,?)`,
      )
      .bind(sectionId, formId, now)
      .run();

    const metricId = newId();
    await db
      .prepare(
        `INSERT INTO metric_definitions
           (id, program_id, metric_key, label, metric_type, is_required, sort_order,
            status, created_at, updated_at)
         VALUES (?,?,'probe_mismatch','Mismatch','integer',0,0,'active',?,?)`,
      )
      .bind(metricId, p.programId, now, now)
      .run();

    // An integer metric answered by a free-text field: the exact shape that
    // silently stores "about four hundred" where a number was promised.
    await expect(
      db
        .prepare(
          `INSERT INTO form_fields
             (id, form_definition_id, form_section_id, field_key, label, field_type,
              is_required, sort_order, metric_definition_id, created_at)
           VALUES (?,?,?,'metric_probe_bad','Bad','long_text',0,0,?,?)`,
        )
        .bind(newId(), formId, sectionId, metricId, now)
        .run(),
      /*
       * THE MESSAGE, not merely "it threw". 0013 carries three separate
       * guards on this table, and an earlier draft of this test passed
       * because the form was an APPLICATION form -- refused by a different
       * trigger entirely, proving nothing about type agreement.
       */
    ).rejects.toThrow(/this field type cannot collect that metric/);
  });
});
