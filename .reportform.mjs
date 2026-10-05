// src/lib/fieldTypes.ts
var DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
var MEDIA_UPLOAD_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm"
];
var MAX_MEDIA_BYTES = 200 * 1024 * 1024;

// src/lib/reportForm.ts
var FIELD_TYPE_BY_METRIC_TYPE = {
  integer: "integer",
  currency: "currency",
  decimal: "decimal",
  text: "long_text"
};
var METRIC_FIELD_PREFIX = "metric_";
var SCAFFOLDED_TEXT_MAX_LENGTH = 4e3;
var DEFAULT_REPORT_NARRATIVE = [
  {
    key: "progress",
    title: "What happened",
    description: "In your own words. Short and specific beats long and general.",
    fields: [
      {
        key: "narrative",
        label: "What did this grant make possible?",
        type: "long_text",
        required: true,
        help: "What you did, who it reached, and what changed as a result.",
        validation: { max_words: 500 }
      },
      {
        key: "challenges",
        label: "What got in the way?",
        type: "long_text",
        help: "Optional, and there is no wrong answer. Plans change. Knowing what did not go as expected is more useful to us than a clean report.",
        validation: { max_words: 300 }
      }
    ]
  },
  {
    key: "attachments",
    title: "Anything to show us",
    description: "Optional, and the part people most enjoy filling in. Photos and video of the work itself tell us more than any number on this form, and they are what we can share with the people who funded it.",
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
        key: "project_media",
        label: "Photos and video",
        type: "file_upload",
        help: "Up to six files, 200 MB each. Anything your phone takes is fine \u2014 including HEIC photos and .mov clips.",
        validation: {
          allowed_mime: MEDIA_UPLOAD_MIME,
          max_size_bytes: MAX_MEDIA_BYTES,
          max_files: 6
        }
      },
      {
        key: "supporting_files",
        label: "Documents",
        type: "file_upload",
        help: "A flyer, a financial summary, an evaluation. PDF, Word, Excel or CSV, up to 15 MB each.",
        validation: { max_files: 3 }
      }
    ]
  }
];
var METRICS_SECTION = {
  key: "metrics",
  title: "The numbers",
  description: "Your best available figures. An estimate you can explain is more useful than a blank."
};
function metricToField(metric) {
  const type = FIELD_TYPE_BY_METRIC_TYPE[metric.metric_type];
  const validation = {};
  if (type === "integer" || type === "decimal") {
    validation.min = 0;
    if (metric.unit) validation.unit_label = metric.unit;
  }
  if (type === "long_text") {
    validation.max_length = SCAFFOLDED_TEXT_MAX_LENGTH;
  }
  return {
    key: `${METRIC_FIELD_PREFIX}${metric.metric_key}`,
    label: metric.label,
    type,
    required: metric.is_required === 1,
    ...metric.help_text ? { help: metric.help_text } : {},
    validation
  };
}
function planReportForm(metrics2, narrative = DEFAULT_REPORT_NARRATIVE) {
  const sections = [];
  const metricFields = metrics2.map(metricToField);
  for (const section of narrative) {
    if (section.key === "attachments" && metricFields.length > 0) {
      sections.push({ ...METRICS_SECTION, fields: metricFields });
    }
    sections.push(section);
  }
  if (metricFields.length > 0 && !sections.some((s) => s.key === METRICS_SECTION.key)) {
    sections.push({ ...METRICS_SECTION, fields: metricFields });
  }
  return sections;
}

// scripts/buildReportFormSql.ts
var [programId, formId, formKey, version, metricsJson] = process.argv.slice(2);
if (!programId || !formId || !formKey || !version) {
  throw new Error("usage: buildReportFormSql <programId> <formId> <formKey> <version> [metricsJson]");
}
var metrics = metricsJson ? JSON.parse(metricsJson) : [];
var now = (/* @__PURE__ */ new Date()).toISOString();
var q = (v) => v === null || v === void 0 ? "NULL" : `'${v.replace(/'/g, "''")}'`;
var idFor = (kind, key) => {
  const seed = `${formId}:${kind}:${key}`;
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + 1, 2246822507) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}-${hex(h2).slice(0, 4)}-4${hex(h1).slice(1, 4)}-8${hex(h2).slice(1, 4)}-${hex(h1)}${hex(h2).slice(0, 4)}`;
};
var lines = [];
lines.push(`-- Generated from planReportForm. Do not edit by hand.`);
lines.push(
  `UPDATE form_definitions SET status='retired', updated_at=${q(now)}
     WHERE program_id=${q(programId)} AND form_key=${q(formKey)}
       AND status='published' AND id<>${q(formId)};`
);
lines.push(
  `INSERT INTO form_definitions
     (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
   VALUES (${q(formId)}, ${q(programId)}, ${q(formKey)}, NULL, 'report', 'Grant report',
           ${Number(version)}, 'draft', ${q(now)}, ${q(now)});`
);
var byMetricKey = new Map(metrics.map((m) => [`metric_${m.metric_key}`, m.id]));
planReportForm(metrics).forEach((section, sectionIndex) => {
  const sectionId = idFor("section", section.key);
  lines.push(
    `INSERT INTO form_sections
       (id, form_definition_id, section_key, title, description, sort_order, created_at)
     VALUES (${q(sectionId)}, ${q(formId)}, ${q(section.key)}, ${q(section.title)},
             ${q(section.description ?? null)}, ${sectionIndex}, ${q(now)});`
  );
  section.fields.forEach((field, fieldIndex) => {
    const validation = field.validation && Object.keys(field.validation).length > 0 ? q(JSON.stringify(field.validation)) : "NULL";
    lines.push(
      `INSERT INTO form_fields
         (id, form_definition_id, form_section_id, field_key, label, help_text, field_type,
          is_required, sort_order, validation_json, options_json, metric_definition_id, created_at)
       VALUES (${q(idFor("field", field.key))}, ${q(formId)}, ${q(sectionId)}, ${q(field.key)},
               ${q(field.label)}, ${q(field.help ?? null)}, ${q(field.type)},
               ${field.required ? 1 : 0}, ${fieldIndex}, ${validation},
               ${field.options && field.options.length > 0 ? q(JSON.stringify(field.options)) : "NULL"},
               ${q(byMetricKey.get(field.key) ?? null)}, ${q(now)});`
    );
  });
});
lines.push(
  `UPDATE form_definitions SET status='published', published_at=${q(now)}, updated_at=${q(now)}
     WHERE id=${q(formId)};`
);
process.stdout.write(lines.join("\n") + "\n");
