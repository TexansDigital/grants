/**
 * Applying a migration to production, on an account where wrangler cannot.
 *
 *   npm run migrate:production
 *
 * WHY THIS IS NOT JUST THE WRANGLER COMMAND. It was, until 2026-10-08, when it
 * failed once:
 *
 *   wrangler d1 migrations apply steward-production --remote --env production
 *   -> The given account is not valid or is not authorized to access this
 *      service [code: 7403]
 *
 * It was then believed that `--json` was the escape and that `d1 migrations
 * apply`, having no such flag, could never work. THAT WAS WRONG. Later the
 * same day a `d1 execute --json` failed with the identical 7403 and succeeded
 * on an immediate retry, byte-identical: the code is intermittent and the flag
 * was never the difference.
 *
 * So TRY `npm run migrate:production:native` FIRST, and retry it once on a
 * 7403. It handles the ledger itself, which is the part that matters.
 *
 * This route is kept because of the property below -- the ledger row written
 * in the same command as the DDL -- not because wrangler's command is known to
 * be unusable. It has not been re-attempted since the one failure.
 *
 * It PRINTS and does not apply. CLAUDE.md's second non-negotiable is that no
 * script writes to production; the same line scripts/apply-sql.mjs draws. A
 * person reads the command and runs it.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const migrations = readdirSync(join(root, 'migrations'))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const latest = migrations[migrations.length - 1];

console.log('Migrations on disk:', migrations.length, `(latest: ${latest})\n`);

console.log('0. TRY WRANGLER FIRST. It handles the ledger itself:\n');
console.log('   npm run migrate:production:native\n');
console.log('   On a 7403, RETRY ONCE before concluding anything -- that code is');
console.log('   intermittent, which was learned the hard way on 2026-10-08.\n');
console.log('   If it works, stop here. The rest of this is the fallback.\n');

console.log('1. Which are already applied? This is read-only:\n');
console.log(
  '   npx wrangler d1 execute steward-production --remote --env production --json \\\n' +
    '     --command="SELECT COUNT(*) AS applied, MAX(name) AS latest FROM d1_migrations"\n',
);

console.log('2. For each migration not yet applied, generate its apply file:\n');
console.log('   node scripts/buildMigrationApply.mjs 0029\n');
console.log('   It refuses anything it cannot make safe to re-run, and says why.\n');

console.log('3. Run it. The ledger row is written in the SAME command, which is');
console.log('   the whole point -- 0028 had its DDL applied without one and');
console.log('   golive then read 27 of 28:\n');
console.log(
  '   npx wrangler d1 execute steward-production --remote --env production --yes \\\n' +
    '     --json --command="$(cat scripts/sql/apply-0029.sql)"\n',
);

console.log('4. Confirm:\n');
console.log('   npm run golive\n');
console.log(`   Expect "${migrations.length} applied, ${migrations.length} on disk".\n`);

const ready = migrations
  .map((m) => m.slice(0, 4))
  .filter((n) => existsSync(join(root, 'scripts', 'sql', `apply-${n}.sql`)));
if (ready.length > 0) {
  console.log('Apply files already generated:', ready.join(', '));
}

console.log('\nNothing has been applied. Step 3 is yours to run.');
