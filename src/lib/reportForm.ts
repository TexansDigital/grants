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

import { MEDIA_UPLOAD_MIME, MAX_MEDIA_BYTES } from './fieldTypes';
import type { RequestContext } from '../types';
import type { FieldType, FieldValidation, FieldOption } from './fieldTypes';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { AppError, notFound } from './errors';
import { loadFormDefinition, assertPublishable } from './loadForm';

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
    description:
      'Optional, and the part people most enjoy filling in. Photos and video of the work ' +
      'itself tell us more than any number on this form, and they are what we can share ' +
      'with the people who funded it.',
    fields: [
      /*
       * TWO FIELDS, NOT ONE, and the split is on purpose.
       *
       * A single "attachments" box asking for a budget and a photo of a
       * classroom gets one of the two, because the label has to describe both
       * and ends up describing neither. Separating them also lets the limits
       * differ honestly: a document is evidence and fits in fifteen megabytes,
       * a video is testimony and does not.
       */
      {
        key: 'project_media',
        label: 'Photos and video',
        type: 'file_upload',
        help:
          'Up to six files, 200 MB each. Anything your phone takes is fine — including ' +
          'HEIC photos and .mov clips.',
        validation: {
          allowed_mime: MEDIA_UPLOAD_MIME,
          max_size_bytes: MAX_MEDIA_BYTES,
          max_files: 6,
        },
      },
      {
        key: 'supporting_files',
        label: 'Documents',
        type: 'file_upload',
        help: 'A flyer, a financial summary, an evaluation. PDF, Word, Excel or CSV, up to 15 MB each.',
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

export interface PublishResult {
  formDefinitionId: string;
  version: number;
  /** The previous published version, now retired. */
  retiredFormDefinitionId: string | null;
  /** Obligations that were waiting for a form and now have this one. */
  periodsAttached: number;
}

/**
 * Publish a draft report form, and attach it to the obligations waiting for it.
 *
 * THE SECOND HALF IS THE POINT, and its absence was a real defect. A report
 * period pins its form at generation, and generation happens when awards are
 * imported -- which is BEFORE anybody has written the questions. Every period
 * generated in that window pinned NULL, and nothing in the system ever set it:
 * `generateReportPeriods` refuses to touch an award that already has periods,
 * by design, so the grantee's portal said "This report form is not ready yet"
 * forever, for every grant imported before the metrics arrived. Which is all of
 * them.
 *
 * So publishing is the moment that resolves it. An admin writing the questions
 * and pressing publish means exactly "these are the questions, ask them" -- and
 * the obligations that have been waiting are precisely what they should be
 * asked on.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED. A period that already names a form keeps
 * it, always. That is the freeze that stops a form edited this March changing
 * the question a grantee answered last October, and a publish must not be a
 * back door through it. Accepted and waived periods are left alone for the same
 * reason: they are finished.
 */
export async function publishReportForm(
  db: D1Database,
  ctx: RequestContext,
  formDefinitionId: string,
  opts: { now?: string } = {},
): Promise<PublishResult> {
  const now = opts.now ?? nowIso();

  const def = await db
    .prepare(
      `SELECT id, program_id, form_key, kind, version, status
         FROM form_definitions WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(formDefinitionId)
    .first<{
      id: string;
      program_id: string;
      form_key: string;
      kind: string;
      version: number;
      status: string;
    }>();
  if (!def) throw notFound('form');

  if (def.kind !== 'report') {
    throw new AppError('VALIDATION_FAILED', 'That is not a report form.', {
      internalMessage: `publishReportForm called on a ${def.kind} definition`,
      severity: 'warn',
    });
  }
  if (def.status !== 'draft') {
    throw new AppError('FORM_PUBLISHED', `This form is already ${def.status}.`, {
      internalMessage: `publish attempted on form ${formDefinitionId} in ${def.status}`,
      severity: 'warn',
    });
  }

  // The same gate an application form passes: a conditional pointing at a
  // field that does not exist, a choice field with no options, a promotion
  // whose type cannot hold it. Publishing is one way -- the mistakes have to
  // be caught before it, not after.
  const loaded = await loadFormDefinition(db, formDefinitionId);
  if (loaded.sections.every((s) => s.fields.length === 0)) {
    throw new AppError('VALIDATION_FAILED', 'This form has no questions in it yet.', {
      internalMessage: `publish attempted on empty report form ${formDefinitionId}`,
      severity: 'warn',
    });
  }
  assertPublishable(loaded);

  // Only one published form per (program, form_key) -- the database says so
  // with a unique index, so the previous one is retired in the same batch
  // rather than left to collide.
  const prior = await db
    .prepare(
      `SELECT id FROM form_definitions
        WHERE program_id = ? AND form_key = ? AND kind = 'report'
          AND status = 'published' AND id <> ? AND deleted_at IS NULL`,
    )
    .bind(def.program_id, def.form_key, formDefinitionId)
    .first<{ id: string }>();

  const waiting = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM report_periods rp
         JOIN awards a ON a.id = rp.award_id AND a.deleted_at IS NULL
        WHERE a.program_id = ? AND rp.form_definition_id IS NULL
          AND rp.status NOT IN ('accepted','waived') AND rp.deleted_at IS NULL`,
    )
    .bind(def.program_id)
    .first<{ n: number }>();
  const periodsAttached = waiting?.n ?? 0;

  const statements: D1PreparedStatement[] = [];

  if (prior) {
    statements.push(
      db
        .prepare(`UPDATE form_definitions SET status = 'retired', updated_at = ? WHERE id = ?`)
        .bind(now, prior.id),
      auditStatement(db, ctx, {
        action: 'form_definition.retired',
        entityType: 'form_definition',
        entityId: prior.id,
        before: { status: 'published' },
        after: { status: 'retired', superseded_by: formDefinitionId },
      }),
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE form_definitions SET status = 'published', published_at = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`,
      )
      .bind(now, now, formDefinitionId),
  );

  if (periodsAttached > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE report_periods SET form_definition_id = ?, updated_at = ?
            WHERE form_definition_id IS NULL
              AND status NOT IN ('accepted','waived')
              AND deleted_at IS NULL
              AND award_id IN (SELECT id FROM awards
                                WHERE program_id = ? AND deleted_at IS NULL)`,
        )
        .bind(formDefinitionId, now, def.program_id),
    );
  }

  statements.push(
    auditStatement(db, ctx, {
      action: 'form_definition.published',
      entityType: 'form_definition',
      entityId: formDefinitionId,
      before: { status: 'draft' },
      after: {
        status: 'published',
        program_id: def.program_id,
        form_key: def.form_key,
        version: def.version,
        report_periods_attached: periodsAttached,
      },
    }),
  );

  await db.batch(statements);

  return {
    formDefinitionId,
    version: def.version,
    retiredFormDefinitionId: prior?.id ?? null,
    periodsAttached,
  };
}
