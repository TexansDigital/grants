/**
 * Put a missing seeded stage into a database that was seeded before it existed.
 *
 *   npm run backfill:stage -- --stage=eligibility            (local)
 *   npm run backfill:stage -- --stage=eligibility --remote   (preview)
 *   npm run backfill:stage -- --stage=eligibility --remote --apply
 *
 * WHY THIS EXISTS. Preview's Inspire Change has one stage. The seed has two:
 * a ten-question eligibility screen at sort_order 0, and the full application
 * at 1. Preview was seeded before the eligibility screen was written, and
 * nothing since has noticed, because listOpenCycles asks for "the lowest
 * sort_order stage with a published form" and got a perfectly valid answer --
 * the application itself.
 *
 * What that produced for a nonprofit: /apply/start rendered all 34 questions
 * inside the eligibility screen, with uploads disabled because no application
 * row exists yet, and a submit that marks the application SUBMITTED. Three
 * required documents, skipped, with no way back. Nobody would have found that
 * from the code, because the code is right; the data drifted.
 *
 * WHY NOT A MIGRATION. This is program content, not schema. A migration that
 * inserts a particular Foundation's form fields would run against every
 * database forever, including ones that should never have this program.
 *
 * WHY NOT RE-RUN THE SEED. Seed ids are deterministic, derived from the slug,
 * so re-running it aborts on the first primary-key collision -- by design, so
 * that a second unremovable copy of a program cannot exist. This takes the
 * SUBSET of that same file belonging to one stage, which carries those same
 * deterministic ids and therefore lands exactly where the seed would have put
 * it.
 *
 * DRY RUN BY DEFAULT. It prints what it would do and writes nothing unless
 * --apply is passed, and it refuses any database whose name mentions
 * production. CLAUDE.md, non-negotiable 2.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SEED = args.seed ?? 'seeds/inspire-change.sql';
const STAGE_KEY = args.stage ?? 'eligibility';
const DATABASE = args.database ?? 'steward-preview';
const REMOTE = args.remote === true;
const APPLY = args.apply === true;
/** A local database somewhere other than .wrangler/state, for rehearsing this. */
const PERSIST = typeof args['persist-to'] === 'string' ? args['persist-to'] : null;
const scope = () =>
  REMOTE ? ['--remote'] : ['--local', ...(PERSIST ? [`--persist-to=${PERSIST}`] : [])];

if (/prod/i.test(String(DATABASE))) {
  console.error(`refusing to write to "${DATABASE}". CLAUDE.md: preview bindings only.`);
  process.exit(2);
}

function query(sqlText) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, ...scope(), '--json', '--command', sqlText],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

console.log(`Steward — backfill the "${STAGE_KEY}" stage into ${DATABASE} (${REMOTE ? 'remote' : 'local'})`);
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}\n`);

// --- find the stage and its form in the seed --------------------------------
const seed = readFileSync(SEED, 'utf8');
const lines = seed.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));

const programId = /INSERT INTO programs [^;]*VALUES \('([0-9a-f-]+)'/.exec(seed)?.[1];
if (!programId) throw new Error(`could not find the program id in ${SEED}`);

/*
 * The stage row, found by its stage_key rather than by a hardcoded id. The
 * ids are deterministic, but writing one into this script would make it a
 * script about one stage of one program forever.
 */
const stageLine = lines.find(
  (l) => l.startsWith('INSERT INTO program_stages') && l.includes(`'${STAGE_KEY}'`),
);
if (!stageLine) throw new Error(`no stage with key "${STAGE_KEY}" in ${SEED}`);
const stageId = /VALUES \('([0-9a-f-]+)'/.exec(stageLine)[1];

const formLine = lines.find(
  (l) => l.startsWith('INSERT INTO form_definitions') && l.includes(`'${stageId}'`),
);
if (!formLine) throw new Error(`stage "${STAGE_KEY}" has no form definition in ${SEED}`);
const formId = /VALUES \('([0-9a-f-]+)'/.exec(formLine)[1];

console.log(`      program: ${programId}`);
console.log(`      stage:   ${stageId}`);
console.log(`      form:    ${formId}\n`);

/*
 * Every statement naming either id, IN SEED ORDER.
 *
 * Order is the whole correctness argument. The seed writes the stage, then
 * the definition as a DRAFT, then its sections and fields, then the UPDATE
 * that publishes it -- because 0003 refuses to add a field to a published
 * definition. Selecting by a predicate and keeping the file's order preserves
 * that for free; re-grouping by table would not.
 */
const selected = lines.filter((l) => l.includes(stageId) || l.includes(formId));
const sections = selected.filter((l) => l.startsWith('INSERT INTO form_sections')).length;
const fields = selected.filter((l) => l.startsWith('INSERT INTO form_fields')).length;
const publishes = selected.filter((l) => l.startsWith('UPDATE form_definitions')).length;

console.log(`      ${selected.length} statements: 1 stage, 1 definition, ` +
            `${sections} sections, ${fields} fields, ${publishes} publish\n`);
if (fields === 0 || publishes !== 1) {
  console.error('that does not look like a complete stage. Refusing to go further.');
  process.exit(1);
}

// --- check the target -------------------------------------------------------
const program = query(`SELECT id, name FROM programs WHERE id='${programId}'`);
if (program.length === 0) {
  console.error(
    `this database has no program with id ${programId}.\n` +
      'The seed derives ids from the slug, so a database seeded from THIS file\n' +
      'would have it. Check you are pointed at the right database.',
  );
  process.exit(1);
}
console.log(`  Target holds: ${program[0].name}`);

const existing = query(
  `SELECT id, name, sort_order FROM program_stages
    WHERE program_id='${programId}' AND deleted_at IS NULL ORDER BY sort_order`,
);
console.log(`  Stages now:   ${existing.map((s) => `${s.sort_order}:${s.name}`).join(', ') || 'none'}`);

if (existing.some((s) => s.id === stageId)) {
  console.log('\nThe stage is already there. Nothing to do.');
  process.exit(0);
}

/*
 * A COLLISION CHECK BEFORE WRITING, not an error caught afterwards.
 *
 * Nothing here is hard-deleted and audit_log is append-only, so a half-applied
 * backfill is not something that can be tidied up. Better to find out that a
 * row is already present while nothing has been written.
 */
const clashes = query(
  `SELECT 'form_definitions' AS t, COUNT(*) AS n FROM form_definitions WHERE id='${formId}'
    UNION ALL
   SELECT 'form_sections', COUNT(*) FROM form_sections WHERE form_definition_id='${formId}'
    UNION ALL
   SELECT 'form_fields', COUNT(*) FROM form_fields WHERE form_definition_id='${formId}'`,
).filter((r) => Number(r.n) > 0);
if (clashes.length > 0) {
  console.error(
    `\nrows already exist for this form: ${clashes.map((c) => `${c.t}=${c.n}`).join(', ')}.\n` +
      'A partial backfill is here already. Stopping rather than writing over it.',
  );
  process.exit(1);
}

const tmp = join(mkdtempSync(join(tmpdir(), 'steward-backfill-')), `${STAGE_KEY}.sql`);
writeFileSync(tmp, `${selected.join('\n')}\n`);

if (!APPLY) {
  console.log(`\n  Would apply ${selected.length} statements from ${SEED}.`);
  console.log(`  The SQL is at ${tmp} if you want to read it first.`);
  console.log(`\n  Re-run with --apply to write it.`);
  process.exit(0);
}

execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', DATABASE, ...scope(), '--file', tmp],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

// --- prove it ---------------------------------------------------------------
console.log('\n  After:\n');
const after = query(
  `SELECT ps.sort_order, ps.name AS stage, fd.name AS form, fd.status,
          (SELECT COUNT(*) FROM form_fields ff WHERE ff.form_definition_id = fd.id) AS fields
     FROM program_stages ps
     LEFT JOIN form_definitions fd ON fd.stage_id = ps.id AND fd.deleted_at IS NULL
    WHERE ps.program_id='${programId}' AND ps.deleted_at IS NULL
    ORDER BY ps.sort_order`,
);
for (const r of after) {
  console.log(`      ${r.sort_order}  ${r.stage} — ${r.form ?? 'no form'} (${r.status ?? '—'}, ${r.fields ?? 0} fields)`);
}

const first = after[0];
const ok = first && first.stage !== 'Application' && first.status === 'published';
console.log(
  `\n${ok ? 'Done.' : 'APPLIED, BUT THE FIRST STAGE IS STILL NOT WHAT YOU WANTED — look above.'}`,
);
console.log('\nThe public list caches nothing, so /apply/start should render the short');
console.log('screen on the next load. Check it before telling anyone to use it.');
process.exit(ok ? 0 : 1);
