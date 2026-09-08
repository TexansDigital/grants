/**
 * Program seeder.
 *
 * Turns a ProgramSpec into rows. This is the only code path that creates a
 * program, and it contains ZERO knowledge of any particular program. Inspire
 * Change and the second program both go through it unchanged.
 *
 * Every write is audited, and the form definition is published only after it
 * passes the lint and the universal maps_to coverage check.
 */

import type { RequestContext } from '../types';
import type { ProgramSpec, FieldSpec } from './types';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/time';
import { auditStatement } from '../lib/audit';
import { assertUniversalCoverage, assertNoDuplicateTargets, DEFAULT_REQUIRED_MAPS_TO } from '../lib/mapsTo';
import { loadFormDefinition, assertPublishable, allFields } from '../lib/forms';
import type { FieldDef } from '../lib/fieldTypes';

export interface SeededProgram {
  programId: string;
  stageIds: Record<string, string>;
  formDefinitionIds: Record<string, string>;
  cycleIds: Record<string, string>;
}

/**
 * Convert a spec field into the in-memory FieldDef shape, for pre-flight
 * validation before anything is written.
 */
function specToFieldDef(spec: FieldSpec, id: string, sectionId: string, order: number): FieldDef {
  return {
    id,
    field_key: spec.key,
    label: spec.label,
    help_text: spec.help ?? null,
    field_type: spec.type,
    is_required: spec.required ?? false,
    sort_order: order,
    options: spec.options ?? [],
    validation: spec.validation ?? {},
    conditional_on_field_id: null, // resolved after all ids are assigned
    conditional_value: spec.conditionalOn?.value ?? null,
    maps_to: spec.mapsTo ?? null,
    section_id: sectionId,
  };
}

/**
 * Seed one program, its stages, its form definitions, and its cycles.
 *
 * `publish` defaults to true: a seeded program is meant to be usable. Passing
 * false leaves the form in draft so it can be edited, which is the state an
 * admin-built program starts in.
 */
export async function seedProgram(
  db: D1Database,
  ctx: RequestContext,
  spec: ProgramSpec,
  opts: { publish?: boolean } = {},
): Promise<SeededProgram> {
  const publish = opts.publish ?? true;
  const now = nowIso();

  const programId = newId();
  const stageIds: Record<string, string> = {};
  const formDefinitionIds: Record<string, string> = {};
  const cycleIds: Record<string, string> = {};

  const statements: D1PreparedStatement[] = [];

  // ---- program ---------------------------------------------------------------
  statements.push(
    db
      .prepare(
        `INSERT INTO programs (
           id, name, slug, description, status, fiscal_year, total_budget_cents,
           compliance_policy, guidelines_version, required_maps_to_json,
           max_applications_per_cycle, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        programId,
        spec.name,
        spec.slug,
        spec.description,
        'active',
        spec.fiscalYear,
        spec.totalBudgetCents,
        spec.compliancePolicy,
        spec.guidelinesVersion,
        JSON.stringify(spec.requiredMapsTo ?? DEFAULT_REQUIRED_MAPS_TO),
        spec.maxApplicationsPerCycle === undefined ? 1 : spec.maxApplicationsPerCycle,
        now,
        now,
      ),
    auditStatement(db, ctx, {
      action: 'program.created',
      entityType: 'program',
      entityId: programId,
      after: { name: spec.name, slug: spec.slug, fiscal_year: spec.fiscalYear },
    }),
  );

  // ---- stages and form definitions -------------------------------------------
  for (const [stageIndex, stage] of spec.stages.entries()) {
    const stageId = newId();
    stageIds[stage.key] = stageId;

    statements.push(
      db
        .prepare(
          `INSERT INTO program_stages (
             id, program_id, stage_key, name, sort_order,
             gate_on_prior_decision, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          stageId,
          programId,
          stage.key,
          stage.name,
          stageIndex,
          stage.gateOnPriorDecision ? 1 : 0,
          now,
          now,
        ),
      auditStatement(db, ctx, {
        action: 'program_stage.created',
        entityType: 'program_stage',
        entityId: stageId,
        after: {
          program_id: programId,
          stage_key: stage.key,
          name: stage.name,
          gate_on_prior_decision: stage.gateOnPriorDecision ? 1 : 0,
        },
      }),
    );

    const formDefinitionId = newId();
    formDefinitionIds[stage.key] = formDefinitionId;

    statements.push(
      db
        .prepare(
          `INSERT INTO form_definitions (
             id, program_id, form_key, stage_id, kind, name, version, status,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        // form_key identifies the form within the program independently of
        // stage, so a program can later carry interim AND final report forms.
        .bind(formDefinitionId, programId, stage.key, stageId, 'application', stage.form.name, 1, 'draft', now, now),
      auditStatement(db, ctx, {
        action: 'form_definition.created',
        entityType: 'form_definition',
        entityId: formDefinitionId,
        after: { program_id: programId, stage_key: stage.key, version: 1, status: 'draft' },
      }),
    );

    // Assign ids up front so conditional references can be resolved without a
    // second pass over the database.
    const fieldIdByKey = new Map<string, string>();
    for (const section of stage.form.sections) {
      for (const field of section.fields) {
        fieldIdByKey.set(field.key, newId());
      }
    }

    const preflightFields: FieldDef[] = [];

    for (const [sectionIndex, section] of stage.form.sections.entries()) {
      const sectionId = newId();
      statements.push(
        db
          .prepare(
            `INSERT INTO form_sections (
               id, form_definition_id, section_key, title, description, sort_order, created_at
             ) VALUES (?,?,?,?,?,?,?)`,
          )
          .bind(
            sectionId,
            formDefinitionId,
            section.key,
            section.title,
            section.description ?? null,
            sectionIndex,
            now,
          ),
        auditStatement(db, ctx, {
          action: 'form_section.created',
          entityType: 'form_definition',
          entityId: formDefinitionId,
          after: { section_id: sectionId, section_key: section.key, title: section.title },
        }),
      );

      for (const [fieldIndex, field] of section.fields.entries()) {
        const fieldId = fieldIdByKey.get(field.key)!;
        const conditionalOnId = field.conditionalOn
          ? (fieldIdByKey.get(field.conditionalOn.fieldKey) ?? null)
          : null;

        if (field.conditionalOn && !conditionalOnId) {
          throw new Error(
            `field "${field.key}" is conditional on "${field.conditionalOn.fieldKey}", which is not in this form`,
          );
        }

        const def = specToFieldDef(field, fieldId, sectionId, fieldIndex);
        def.conditional_on_field_id = conditionalOnId;
        preflightFields.push(def);

        statements.push(
          db
            .prepare(
              `INSERT INTO form_fields (
                 id, form_definition_id, form_section_id, field_key, label, help_text,
                 field_type, is_required, sort_order, options_json, validation_json,
                 conditional_on_field_id, conditional_value, maps_to, translations_json, created_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              fieldId,
              formDefinitionId,
              sectionId,
              field.key,
              field.label,
              field.help ?? null,
              field.type,
              field.required ? 1 : 0,
              fieldIndex,
              field.options ? JSON.stringify(field.options) : null,
              field.validation ? JSON.stringify(field.validation) : null,
              conditionalOnId,
              field.conditionalOn?.value ?? null,
              field.mapsTo ?? null,
              // Reserved for field-level Spanish. English only today; the column
              // exists so adding it later is content entry, not a migration.
              null,
              now,
            ),
          // A field row decides which question becomes requested_amount_cents.
          // That is a configuration change worth an audit row.
          auditStatement(db, ctx, {
            action: 'form_field.created',
            entityType: 'form_definition',
            entityId: formDefinitionId,
            after: {
              field_id: fieldId,
              field_key: field.key,
              field_type: field.type,
              is_required: field.required ? 1 : 0,
              maps_to: field.mapsTo ?? null,
            },
          }),
        );
      }
    }

    // Pre-flight the configuration BEFORE writing. A program that cannot be
    // published is a program an admin has to debug at 11pm on launch day.
    assertNoDuplicateTargets(preflightFields);
    assertUniversalCoverage(preflightFields, spec.requiredMapsTo ?? DEFAULT_REQUIRED_MAPS_TO);
  }

  // ---- cycles ---------------------------------------------------------------
  for (const cycle of spec.cycles) {
    const cycleId = newId();
    cycleIds[cycle.name] = cycleId;
    statements.push(
      db
        .prepare(
          `INSERT INTO cycles (
             id, program_id, name, opens_at, closes_at, decision_due_at,
             announcement_date, status, draft_grace_hours, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          cycleId,
          programId,
          cycle.name,
          cycle.opensAt,
          cycle.closesAt,
          cycle.decisionDueAt ?? null,
          cycle.announcementDate ?? null,
          cycle.status ?? 'draft',
          cycle.draftGraceHours ?? 0,
          now,
          now,
        ),
      auditStatement(db, ctx, {
        action: 'cycle.created',
        entityType: 'cycle',
        entityId: cycleId,
        after: { program_id: programId, name: cycle.name, closes_at: cycle.closesAt },
      }),
    );
  }

  await db.batch(statements);

  if (publish) {
    for (const stage of spec.stages) {
      await publishFormDefinition(db, ctx, formDefinitionIds[stage.key]!);
    }
  }

  return { programId, stageIds, formDefinitionIds, cycleIds };
}

/**
 * Publish a form definition.
 *
 * Lint and universal-coverage run here, against what is actually in the
 * database rather than against the spec, because an admin-built form never had
 * a spec. Publishing freezes the shape: the triggers in migration 0003 will
 * refuse any further edit to its sections or fields.
 */
export async function publishFormDefinition(
  db: D1Database,
  ctx: RequestContext,
  formDefinitionId: string,
): Promise<void> {
  const definition = await loadFormDefinition(db, formDefinitionId);

  if (definition.status === 'published') return;
  if (definition.status === 'retired') {
    throw new Error(`form definition ${formDefinitionId} is retired`);
  }

  assertPublishable(definition);
  const fields = allFields(definition);
  assertNoDuplicateTargets(fields);
  if (definition.kind === 'application') {
    // The required set is the PROGRAM's, not a global constant.
    const program = await db
      .prepare(`SELECT required_maps_to_json AS req FROM programs WHERE id = ?`)
      .bind(definition.program_id)
      .first<{ req: string }>();
    let required: string[] = [...DEFAULT_REQUIRED_MAPS_TO];
    if (program?.req) {
      try {
        const parsed = JSON.parse(program.req);
        if (Array.isArray(parsed)) required = parsed.map(String);
      } catch {
        // Malformed configuration falls back to the safe default rather than
        // publishing a form that collects nothing.
      }
    }
    assertUniversalCoverage(fields, required);
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE form_definitions
            SET status = 'published', published_at = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`,
      )
      .bind(now, now, formDefinitionId),
    auditStatement(db, ctx, {
      action: 'form_definition.published',
      entityType: 'form_definition',
      entityId: formDefinitionId,
      before: { status: 'draft' },
      after: { status: 'published', published_at: now, field_count: fields.length },
    }),
  ]);
}
