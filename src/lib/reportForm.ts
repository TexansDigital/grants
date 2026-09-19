/**
 * Scaffolding a report form out of a program's metric definitions.
 *
 * 0012 said metric definitions are "rendered INTO a report form as fields" and
 * are "not a second form engine". This is the rendering, and the important word
 * is SCAFFOLD: it writes ordinary form_definitions / form_sections /
 * form_fields rows, in DRAFT, and then gets out of the way. An admin edits the
 * wording, adds a question, deletes one, and publishes. After that moment the
 * rows are the form and this file has no further say in it.
 *
 * That is deliberate, and it is the reason this is not a renderer that reads
 * metric_definitions at request time. A published form is frozen and a metric
 * definition is not; a live render would mean that fixing a typo in a metric's
 * label next March silently changes the question a grantee answered last
 * October, with their answer still attached to it. The field row carries a
 * COPY of the wording and a REFERENCE to the metric. The copy is what was
 * asked; the reference is what the answer counts toward. Both are needed and
 * they are not the same fact.
 *
 * The narrative questions below are a default, in the same way
 * src/seed/inspireChange.ts is a default: a spec in code that becomes rows
 * once. Pass your own and this file has no opinion at all.
 *
 * KNOWN DIFFERENCE FROM APPLICATIONS, stated rather than hidden:
 * application_answers snapshots field_key, label_at_answer and field_type
 * beside each answer; report_answers does not. It is safe today because a
 * report period pins its form_definition_id and a published definition cannot
 * change, so the join to form_fields always returns the wording the grantee
 * saw. It is a thinner guarantee than applications have, and if report forms
 * ever gain an in-place edit path it stops being true.
 */

import type { RequestContext } from '../types';
import type { FieldType, FieldValidation, FieldOption } from './fieldTypes';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { AppError, notFound } from './errors';

/** A metric definition row, as the builder needs it. */
export interface MetricDefinition {
  id: string;
  metric_key: string;
  label: string;
  help_text: string | null;
  metric_type: 'integer' | 'currency' | 'decimal' | 'text';
  unit: string | null;
  is_required: number;
  sort_order: number;
  promotes_to: string | null;
}

/**
 * Which field type collects which metric type.
 *
 * This must agree with the trigger in migration 0013. It is duplicated on
 * purpose: the trigger is the guarantee (it holds against any writer, including
 * a hand-run SQL script), and this is the choice the scaffolder makes. A
 * mismatch between the two is caught by a test rather than by a grantee.
 *
 * 'text' scaffolds as long_text because a metric of that type is described in
 * 0012 as "a description that cannot be a number". An admin who wanted one line
 * changes it to short_text in the draft; the trigger permits both.
 */
export const FIELD_TYPE_BY_METRIC_TYPE: Record<MetricDefinition['metric_type'], FieldType> = {
  integer: 'integer',
  currency: 'currency',
  decimal: 'decimal',
  text: 'long_text',
};

/**
 * Prefix on every scaffolded metric field key.
 *
 * Field keys are unique per form definition, and the narrative questions below
 * are chosen by whoever calls this while the metric keys come from a CSV
 * somebody else wrote. Namespacing the generated half removes the collision
 * entirely instead of detecting it, and it makes the origin of a key obvious
 * in an export.
 */
export const METRIC_FIELD_PREFIX = 'metric_';

/**
 * A hard ceiling on a scaffolded text metric, not an editorial one.
 *
 * There is no "right" length for "what does that number count?", so this is not
 * trying to be one -- it is the bound that keeps a pasted PDF out of a D1 row,
 * which maxes out at 2 MB. An admin who wants a real word limit sets one on the
 * draft, and gets the live counter that comes with it.
 */
export const SCAFFOLDED_TEXT_MAX_LENGTH = 4000;

export interface ReportFieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  options?: FieldOption[];
  validation?: FieldValidation;
}

export interface ReportSectionSpec {
  key: string;
  title: string;
  description?: string;
  fields: ReportFieldSpec[];
}

/**
 * The questions every grant report asks, whatever the program counts.
 *
 * Kept short on purpose. A grantee reporting on a $25,000 grant is a program
 * director doing this at the end of a long day, and every question here is one
 * somebody has to write a paragraph for. The numbers section carries the
 * program's own asks; this is the part that makes them mean something.
 */
export const DEFAULT_REPORT_NARRATIVE: ReportSectionSpec[] = [
  {
    key: 'progress',
    title: 'What happened',
    description: 'In your own words. Short and specific beats long and general.',
    fields: [
      {
        key: 'narrative',
        label: 'What did this grant make possible?',
        type: 'long_text',
        required: true,
        help: 'What you did, who it reached, and what changed as a result.',
        validation: { max_words: 500 },
      },
      {
        key: 'challenges',
        label: 'What got in the way?',
        type: 'long_text',
        help:
          'Optional, and there is no wrong answer. Plans change. Knowing what ' +
          'did not go as expected is more useful to us than a clean report.',
        validation: { max_words: 300 },
      },
    ],
  },
  {
    key: 'attachments',
    title: 'Anything to show us',
    description: 'Optional. Photos, a flyer, a financial summary — whatever you already have.',
    fields: [
      {
        key: 'supporting_files',
        label: 'Attach up to three files',
        type: 'file_upload',
        help: 'PDF, Word, Excel, or an image. Up to 15 MB each.',
        validation: { max_files: 3 },
      },
    ],
  },
];

/** The section the generated metric fields go into. */
export const METRICS_SECTION: Omit<ReportSectionSpec, 'fields'> = {
  key: 'metrics',
  title: 'The numbers',
  description:
    'Your best available figures. An estimate you can explain is more useful than a blank.',
};

/**
 * Turn one metric definition into a field spec.
 *
 * Pure, so the scaffolding decisions can be argued with in a test rather than
 * by reading a batch of INSERTs.
 */
export function metricToField(metric: MetricDefinition): ReportFieldSpec {
  const type = FIELD_TYPE_BY_METRIC_TYPE[metric.metric_type];
  const validation: FieldValidation = {};

  if (type === 'integer' || type === 'decimal') {
    // A count or a rate below zero is a typo. Money has its own floor in
    // parseCurrencyToCents, which refuses a negative outright.
    validation.min = 0;
    if (metric.unit) validation.unit_label = metric.unit;
  }
  if (type === 'long_text') {
    validation.max_length = SCAFFOLDED_TEXT_MAX_LENGTH;
  }

  return {
    key: `${METRIC_FIELD_PREFIX}${metric.metric_key}`,
    label: metric.label,
    type,
    required: metric.is_required === 1,
    ...(metric.help_text ? { help: metric.help_text } : {}),
    validation,
  };
}

/**
 * The whole scaffolded form, as a spec, before anything is written.
 *
 * Separated from the writing for the same reason planReportPeriods is: this is
 * the part with the judgement in it.
 */
export function planReportForm(
  metrics: readonly MetricDefinition[],
  narrative: readonly ReportSectionSpec[] = DEFAULT_REPORT_NARRATIVE,
): ReportSectionSpec[] {
  const sections: ReportSectionSpec[] = [];
  const metricFields = metrics.map(metricToField);

  for (const section of narrative) {
    // The numbers belong after "what happened" and before the attachments: a
    // grantee answers what they did before being asked to count it.
    if (section.key === 'attachments' && metricFields.length > 0) {
      sections.push({ ...METRICS_SECTION, fields: metricFields });
    }
    sections.push(section);
  }
  // A narrative spec with no attachments section still gets its numbers.
  if (metricFields.length > 0 && !sections.some((s) => s.key === METRICS_SECTION.key)) {
    sections.push({ ...METRICS_SECTION, fields: metricFields });
  }
  return sections;
}

/** Load a program's active metric definitions, in the order they are asked. */
export async function loadMetricDefinitions(
  db: D1Database,
  programId: string,
): Promise<MetricDefinition[]> {
  const { results } = await db
    .prepare(
      `SELECT id, metric_key, label, help_text, metric_type, unit, is_required,
              sort_order, promotes_to
         FROM metric_definitions
        WHERE program_id = ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY sort_order, metric_key`,
    )
    .bind(programId)
    .all<MetricDefinition>();
  return results ?? [];
}

export interface BuildReportFormResult {
  formDefinitionId: string;
  version: number;
  /** Metric definition ids that became fields, in form order. */
  metricIds: string[];
  fieldCount: number;
}

/**
 * Write a draft report form for a program.
 *
 * Always a DRAFT, always a new version. Never published here: publishing is a
 * human deciding a form is ready, and it is the moment after which the form can
 * never be edited again. Handing that decision to a scaffolder would mean an
 * admin discovering the wording they wanted to change is already frozen.
 */
export async function buildReportForm(
  db: D1Database,
  ctx: RequestContext,
  opts: {
    programId: string;
    /** Identifies this form within the program across versions. */
    formKey?: string;
    name?: string;
    narrative?: readonly ReportSectionSpec[];
    now?: string;
  },
): Promise<BuildReportFormResult> {
  const formKey = opts.formKey ?? 'grant_report';
  const now = opts.now ?? nowIso();

  const program = await db
    .prepare(`SELECT id, name FROM programs WHERE id = ? AND deleted_at IS NULL`)
    .bind(opts.programId)
    .first<{ id: string; name: string }>();
  if (!program) throw notFound('program');

  const metrics = await loadMetricDefinitions(db, opts.programId);
  const sections = planReportForm(metrics, opts.narrative);

  // Field keys are unique per definition and the database says so. Catching it
  // here turns a constraint violation into a sentence naming the duplicate.
  const seen = new Set<string>();
  for (const section of sections) {
    for (const f of section.fields) {
      if (seen.has(f.key)) {
        throw new AppError('VALIDATION_FAILED', `Two questions share the key "${f.key}".`, {
          internalMessage: `duplicate field key ${f.key} scaffolding report form for ${opts.programId}`,
          severity: 'warn',
          context: { field_key: f.key },
        });
      }
      seen.add(f.key);
    }
  }

  const prior = await db
    .prepare(
      `SELECT MAX(version) AS v FROM form_definitions
        WHERE program_id = ? AND form_key = ? AND deleted_at IS NULL`,
    )
    .bind(opts.programId, formKey)
    .first<{ v: number | null }>();
  const version = (prior?.v ?? 0) + 1;

  const formDefinitionId = newId();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO form_definitions
           (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
         VALUES (?,?,?,NULL,'report',?,?, 'draft', ?,?)`,
      )
      .bind(
        formDefinitionId,
        opts.programId,
        formKey,
        opts.name ?? `${program.name} grant report`,
        version,
        now,
        now,
      ),
    auditStatement(db, ctx, {
      action: 'form_definition.scaffolded',
      entityType: 'form_definition',
      entityId: formDefinitionId,
      after: {
        program_id: opts.programId,
        form_key: formKey,
        kind: 'report',
        version,
        metric_count: metrics.length,
      },
    }),
  ];

  // Which metric each generated field reports, by field key.
  const metricIdByFieldKey = new Map(
    metrics.map((m) => [`${METRIC_FIELD_PREFIX}${m.metric_key}`, m.id]),
  );
  const metricIds: string[] = [];
  let fieldCount = 0;

  for (const [sectionIndex, section] of sections.entries()) {
    const sectionId = newId();
    statements.push(
      db
        .prepare(
          `INSERT INTO form_sections
             (id, form_definition_id, section_key, title, description, sort_order, created_at)
           VALUES (?,?,?,?,?,?,?)`,
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
    );

    for (const [fieldIndex, field] of section.fields.entries()) {
      const fieldId = newId();
      const metricId = metricIdByFieldKey.get(field.key) ?? null;
      if (metricId) metricIds.push(metricId);
      fieldCount += 1;

      statements.push(
        db
          .prepare(
            `INSERT INTO form_fields
               (id, form_definition_id, form_section_id, field_key, label, help_text,
                field_type, is_required, sort_order, options_json, validation_json,
                conditional_on_field_id, conditional_value, maps_to, metric_definition_id,
                translations_json, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?)`,
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
            field.validation && Object.keys(field.validation).length > 0
              ? JSON.stringify(field.validation)
              : null,
            metricId,
            now,
          ),
      );
    }
  }

  // One audit row for the scaffold, not one per field. A generated form is a
  // single act by one admin; forty rows saying so buries the acts that matter.
  // Every later edit to these rows is audited individually by the admin routes.
  await db.batch(statements);

  return { formDefinitionId, version, metricIds, fieldCount };
}
