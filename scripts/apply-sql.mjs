/**
 * Apply a .sql file to D1 through the path that accepts an OAuth login.
 *
 *   node scripts/apply-sql.mjs --file=seeds/community-futures-fund.sql --remote
 *
 * WHY THIS EXISTS, rather than `wrangler d1 execute --file`.
 *
 * Wrangler sends a small file inline and switches to D1's bulk IMPORT endpoint
 * above a size threshold. That endpoint refuses an OAuth token:
 *
 *   ✘ A request to the Cloudflare API (/d1/database/<id>/import) failed.
 *     Authentication error [code: 10000]
 *
 * It is not a missing permission -- the same login carries `d1 (write)` and
 * runs migrations and queries happily. It is that endpoint. Which is why
 * `seeds/admins.sql` has always applied (it is tiny) and a 37 KB seed does not.
 *
 * The alternative is minting a scoped Cloudflare API token and exporting
 * CLOUDFLARE_API_TOKEN. That is a perfectly good answer and a second long-lived
 * credential to look after, for a seed file. This sends the same statements
 * through the inline path instead, in batches, and needs nothing new.
 *
 * SAFETY. `--remote` without an explicit `--db` targets steward-preview, which
 * is the only database the default configuration points at. There is no
 * production flag and there will not be one: CLAUDE.md's second
 * non-negotiable is that production is never written to by a script.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);

const file = args.get('file');
const db = args.get('db') ?? 'steward-preview';
const remote = Boolean(args.get('remote'));

if (!file || file === true) {
  console.error('Usage: node scripts/apply-sql.mjs --file=<path.sql> [--db=<name>] [--remote]');
  process.exit(2);
}

/*
 * One statement per line, which is what src/seed/emitSql.ts produces.
 *
 * Splitting on ';' would be wrong in general -- a semicolon inside a string
 * literal is not a statement boundary, and these files carry JSON in
 * options_json. Splitting on lines is correct for this emitter and obviously
 * incorrect for a hand-written file, so it checks rather than assumes.
 */
const lines = readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('--'));

const notStatements = lines.filter((l) => !l.endsWith(';'));
if (notStatements.length > 0) {
  console.error(
    `${file} has ${notStatements.length} line(s) that are not a complete statement.\n` +
      'This tool expects one statement per line, as emitted by src/seed/emitSql.ts.\n' +
      `First offender: ${notStatements[0].slice(0, 120)}`,
  );
  process.exit(1);
}

// Comfortably inside any command-line length limit, and small enough that a
// failure names a handful of statements rather than seventy.
const BATCH_BYTES = 12_000;

const batches = [];
let current = [];
let size = 0;
for (const statement of lines) {
  if (current.length > 0 && size + statement.length > BATCH_BYTES) {
    batches.push(current);
    current = [];
    size = 0;
  }
  current.push(statement);
  size += statement.length;
}
if (current.length > 0) batches.push(current);

console.log(
  `${file}: ${lines.length} statements in ${batches.length} batch(es), ` +
    `against ${db} (${remote ? 'REMOTE' : 'local'}).`,
);

let applied = 0;
batches.forEach((batch, i) => {
  process.stdout.write(`  batch ${i + 1}/${batches.length} (${batch.length} statements)… `);
  try {
    execFileSync(
      'npx',
      [
        'wrangler', 'd1', 'execute', db,
        remote ? '--remote' : '--local',
        '--yes',
        '--command', batch.join('\n'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    applied += batch.length;
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    // The API's own message, not a summary of it. A seed that half-applied
    // needs the actual constraint name to be worth anything.
    console.error(String(e.stdout ?? '') + String(e.stderr ?? ''));
    console.error(
      `\nStopped after ${applied} of ${lines.length} statements. ` +
        'Nothing is rolled back: D1 has no cross-statement transaction here, so ' +
        'inspect before re-running.',
    );
    process.exit(1);
  }
});

console.log(`Applied ${applied} statements.`);
