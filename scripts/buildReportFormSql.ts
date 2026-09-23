/**
 * Emit SQL for a report form built from the REAL scaffolder's plan.
 *
 *   npm run reportform:build -- <programId> <formId> <formKey> <version>
 *
 * WHY THIS EXISTS AT ALL. e2e-grantee.mjs writes its own report form in
 * hand-rolled SQL, because the endpoint that builds one is behind Cloudflare
 * Access and a harness cannot mint an Access assertion. That hand-rolled copy
 * has drifted from reportForm.ts twice already -- its own header records both
 * occasions -- and each time the drift was invisible until an assertion failed
 * thirty seconds away from the cause.
 *
 * Duplicating it a third time to get a media field into a browser would be
 * choosing the same mistake on purpose. So the plan comes from planReportForm,
 * the one function that decides what a report asks, and only the INSERT
 * spelling lives here. A field added to DEFAULT_REPORT_NARRATIVE appears in the
 * harness without anybody remembering to copy it.
 *
 * It writes a DRAFT and publishes it in the same file, in that order, because
 * 0003 makes a published definition immutable by trigger: fields written after
 * the publish are refused outright.
 *
 * Local preview only. It emits text; applying it is a separate, deliberate
 * step, and nothing here can reach a production binding.
 */
import { planReportForm, type MetricDefinition } from '../src/lib/reportForm';

const [programId, formId, formKey, version, metricsJson] = process.argv.slice(2);
if (!programId || !formId || !formKey || !version) {
  throw new Error('usage: buildReportFormSql <programId> <formId> <formKey> <version> [metricsJson]');
}

const metrics: MetricDefinition[] = metricsJson ? JSON.parse(metricsJson) : [];
const now = new Date().toISOString();

/** Single-quote escaping only. Every value here is ours; none of it is user input. */
const q = (v: string | null | undefined): string =>
  v === null || v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`;

/*
 * A deterministic id per field, derived from the form id and the field key.
 * The harness needs to know nothing about ids to assert on a field, and a
 * rerun against the same form id produces the same rows rather than duplicates.
 */
const idFor = (kind: string, key: string): string => {
  const seed = `${formId}:${kind}:${key}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  // Shaped like a UUID so it reads as one in a database dump. It is not random
  // and is not meant to be: these rows belong to one harness run.
  return `${hex(h1)}-${hex(h2).slice(0, 4)}-4${hex(h1).slice(1, 4)}-8${hex(h2).slice(1, 4)}-${hex(h1)}${hex(h2).slice(0, 4)}`;
};

const lines: string[] = [];
lines.push(`-- Generated from planReportForm. Do not edit by hand.`);

// Retire whatever is published for this key first: only one published
// definition per (program, form_key) is allowed, and an empty one left by a
// failed run is exactly what that index exists to stop being reused.
lines.push(
  `UPDATE form_definitions SET status='retired', updated_at=${q(now)}
     WHERE program_id=${q(programId)} AND form_key=${q(formKey)}
       AND status='published' AND id<>${q(formId)};`,
);

lines.push(
  `INSERT INTO form_definitions
     (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
   VALUES (${q(formId)}, ${q(programId)}, ${q(formKey)}, NULL, 'report', 'Grant report',
           ${Number(version)}, 'draft', ${q(now)}, ${q(now)});`,
);

const byMetricKey = new Map(metrics.map((m) => [`metric_${m.metric_key}`, m.id]));

planReportForm(metrics).forEach((section, sectionIndex) => {
  const sectionId = idFor('section', section.key);
  lines.push(
    `INSERT INTO form_sections
       (id, form_definition_id, section_key, title, description, sort_order, created_at)
     VALUES (${q(sectionId)}, ${q(formId)}, ${q(section.key)}, ${q(section.title)},
             ${q(section.description ?? null)}, ${sectionIndex}, ${q(now)});`,
  );
  section.fields.forEach((field, fieldIndex) => {
    const validation =
      field.validation && Object.keys(field.validation).length > 0
        ? q(JSON.stringify(field.validation))
        : 'NULL';
    lines.push(
      `INSERT INTO form_fields
         (id, form_definition_id, form_section_id, field_key, label, help_text, field_type,
          is_required, sort_order, validation_json, options_json, metric_definition_id, created_at)
       VALUES (${q(idFor('field', field.key))}, ${q(formId)}, ${q(sectionId)}, ${q(field.key)},
               ${q(field.label)}, ${q(field.help ?? null)}, ${q(field.type)},
               ${field.required ? 1 : 0}, ${fieldIndex}, ${validation},
               ${field.options && field.options.length > 0 ? q(JSON.stringify(field.options)) : 'NULL'},
               ${q(byMetricKey.get(field.key) ?? null)}, ${q(now)});`,
    );
  });
});

// Published last. See the header.
lines.push(
  `UPDATE form_definitions SET status='published', published_at=${q(now)}, updated_at=${q(now)}
     WHERE id=${q(formId)};`,
);

process.stdout.write(lines.join('\n') + '\n');
