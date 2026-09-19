/**
 * Import a program's impact metrics, and build the report form from them.
 *
 *   npm run metrics -- --program=inspire-change --file=metrics.csv          # dry run
 *   npm run metrics -- --program=inspire-change --file=metrics.csv --apply
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT. The same reason the seeder emits
 * SQL rather than exposing /seed: a metrics file is configuration for a whole
 * program, it is applied by a named human act, and nothing about it needs to
 * ship in the Worker bundle.
 *
 * TARGETS. `--local` (the default) is the local preview database. `--preview`
 * is the remote preview database and has to be typed out. There is no
 * production flag and there will not be one here; CLAUDE.md is explicit that a
 * data-mutating script never runs against production without being told to in
 * that specific message, and a flag in a checked-in script is not that.
 *
 * DRY RUN BY DEFAULT. Without --apply it reads, plans and prints, and writes
 * nothing. The plan it prints is exactly what --apply would do.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const FILE = args.file;
const PROGRAM = args.program;
const APPLY = args.apply === true;
const TARGET = args.preview === true ? '--remote' : '--local';

if (!FILE || !PROGRAM) {
  console.error(
    'Usage: npm run metrics -- --program=<slug> --file=<path.csv> [--apply] [--preview]',
  );
  process.exit(2);
}

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', TARGET, '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

/** SQL string literal. Single quotes doubled; nothing else is interpolated. */
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// --- parse ------------------------------------------------------------------
// The parser is the one the Worker uses, bundled here rather than reimplemented,
// so a file this accepts is a file the system accepts.
const { parseMetricsCsv, formatMetricReport } = await import('../.metricsbuild.mjs');

const text = readFileSync(FILE, 'utf8');
const parsed = parseMetricsCsv(text);
console.log(formatMetricReport(parsed));
if (!parsed.ok) process.exit(1);

// --- plan -------------------------------------------------------------------
const program = sql(
  `SELECT id, name FROM programs WHERE slug=${q(PROGRAM)} AND deleted_at IS NULL`,
)[0];
if (!program) {
  console.error(`\nNo program with slug "${PROGRAM}" in the ${TARGET.slice(2)} database.`);
  process.exit(1);
}
console.log(`\nProgram: ${program.name} (${program.id}) — ${TARGET.slice(2)} database`);

const existing = sql(
  `SELECT id, metric_key, label, help_text, metric_type, unit, is_required, sort_order,
          status, promotes_to
     FROM metric_definitions WHERE program_id=${q(program.id)} AND deleted_at IS NULL`,
);
const byKey = new Map(existing.map((m) => [m.metric_key, m]));

const plan = { create: [], update: [], unchanged: [], blocked: [], missing: [] };
for (const m of parsed.metrics) {
  const prior = byKey.get(m.metricKey);
  if (!prior) {
    plan.create.push(m);
    continue;
  }
  if (prior.metric_type !== m.metricType) {
    plan.blocked.push(
      `"${m.metricKey}" is already a ${prior.metric_type} metric and this file makes it ` +
        `${m.metricType}. Values already reported against it were collected as the old type. ` +
        'Retire it and add a new metric under a different key instead.',
    );
    continue;
  }
  const changed =
    prior.label !== m.label ||
    (prior.help_text ?? null) !== m.helpText ||
    (prior.unit ?? null) !== m.unit ||
    (prior.is_required === 1) !== m.isRequired ||
    prior.sort_order !== m.sortOrder ||
    (prior.promotes_to ?? null) !== m.promotesTo ||
    prior.status !== 'active';
  (changed ? plan.update : plan.unchanged).push({ ...m, id: prior.id });
}
for (const prior of byKey.values()) {
  if (prior.status === 'active' && !parsed.metrics.some((m) => m.metricKey === prior.metric_key)) {
    plan.missing.push(prior.metric_key);
  }
}

console.log(
  `\nPlan: ${plan.create.length} to add, ${plan.update.length} to change, ` +
    `${plan.unchanged.length} unchanged.`,
);
for (const m of plan.create) console.log(`  add     ${m.metricKey}`);
for (const m of plan.update) console.log(`  change  ${m.metricKey}`);
if (plan.missing.length > 0) {
  console.log(
    `\n${plan.missing.length} metric(s) in the program are not in this file. ` +
      'They are LEFT ALONE — retiring one is a separate deliberate act:',
  );
  for (const k of plan.missing) console.log(`  kept    ${k}`);
}
if (plan.blocked.length > 0) {
  console.log('\nBlocked:');
  for (const b of plan.blocked) console.log(`  ${b}`);
  console.log('\nNothing was written. Fix the file and run it again.');
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Add --apply to write it.');
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
const now = new Date().toISOString();
const uuid = () => crypto.randomUUID();

// Clear every funds-spent claim first: one per program, so moving it between
// two metrics fails if the new claimant is written while the old one holds it.
if (parsed.metrics.some((m) => m.promotesTo)) {
  sql(
    `UPDATE metric_definitions SET promotes_to=NULL, updated_at=${q(now)}
      WHERE program_id=${q(program.id)} AND promotes_to IS NOT NULL AND deleted_at IS NULL`,
  );
}

for (const m of plan.create) {
  sql(
    `INSERT INTO metric_definitions
       (id, program_id, metric_key, label, help_text, metric_type, unit, is_required,
        sort_order, status, promotes_to, created_at, updated_at)
     VALUES (${q(uuid())}, ${q(program.id)}, ${q(m.metricKey)}, ${q(m.label)},
             ${q(m.helpText)}, ${q(m.metricType)}, ${q(m.unit)}, ${m.isRequired ? 1 : 0},
             ${m.sortOrder}, 'active', ${q(m.promotesTo)}, ${q(now)}, ${q(now)})`,
  );
}
for (const m of plan.update) {
  sql(
    `UPDATE metric_definitions
        SET label=${q(m.label)}, help_text=${q(m.helpText)}, unit=${q(m.unit)},
            is_required=${m.isRequired ? 1 : 0}, sort_order=${m.sortOrder},
            promotes_to=${q(m.promotesTo)}, status='active', updated_at=${q(now)}
      WHERE id=${q(m.id)}`,
  );
}

console.log(`\nWrote ${plan.create.length} new and ${plan.update.length} changed metric(s).`);
console.log(
  '\nNext: build the report form from these metrics and publish it.\n' +
    '  The form is a DRAFT first, so you can reword any question before it is frozen.\n' +
    '  Publishing also opens every report obligation that has been waiting for a form.',
);
