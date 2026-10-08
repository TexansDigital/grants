/**
 * Run every browser harness, and say what is missing when one cannot run.
 *
 *   npm run e2e
 *
 * WHY THIS EXISTS. `npm run verify` does not run the harnesses -- they need a
 * browser, a local server and a seeded database, and they take minutes. So
 * they drift, silently, and a harness nobody runs asserts whatever it likes:
 * `e2e-reminders` spent an unknown period asserting that a SUPPRESSED reminder
 * stamps the report period as chased, which is the exact bug that was found and
 * fixed in the library on 2026-10-08. The fix corrected the unit tests. Nothing
 * corrected the harness, because nothing ran it.
 *
 * WHY IT CHECKS PREREQUISITES FIRST. Every way a harness fails for want of
 * local setup looks like a code regression:
 *
 *   - no `.dev.vars`  -> public endpoints refuse everything (Turnstile fails
 *                        closed, correctly) and the applicant harnesses fail
 *                        with FORBIDDEN or a locator timeout.
 *   - no local server -> ERR_CONNECTION_REFUSED, reported against whichever
 *                        locator was being awaited.
 *   - unseeded database -> "no rows for: SELECT id FROM programs".
 *
 * Each of those cost a debugging session before this script said them out
 * loud. None of them is a bug in the code under test.
 */

import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const problems = [];

if (!existsSync(join(root, '.dev.vars'))) {
  problems.push(
    'No .dev.vars. The public endpoints fail closed without it, which is correct,\n' +
      '    and every applicant harness then fails in a way that looks like a bug.\n' +
      '    Fix:  cp .dev.vars.example .dev.vars     (invented values only)',
  );
}

const reachable = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
};

if (!(await reachable('http://127.0.0.1:8787/'))) {
  problems.push(
    'Nothing is serving 127.0.0.1:8787.\n' +
      '    Fix:  npm run dev:applicant      (sets APPLICANT_BASE_URL, which e2e-signin needs;\n' +
      '                                       plain `npm run dev` leaves / on the staff app)',
  );
}
if (!(await reachable('http://127.0.0.1:5173/'))) {
  problems.push('Nothing is serving 127.0.0.1:5173.\n    Fix:  npm run dev:web');
}

if (problems.length > 0) {
  console.error('Cannot run the harnesses yet:\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error('Also needed: a migrated and seeded local database --');
  console.error('    npm run migrate:local && npm run seed:local');
  console.error('  and, for e2e-media, the second program:');
  console.error(
    '    npx wrangler d1 execute steward-preview --local --yes --json \\\n' +
      '      --file=seeds/community-futures-fund.sql',
  );
  process.exit(2);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const harnesses = readdirSync(here)
  .filter((f) => /^e2e-.*\.mjs$/.test(f))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

console.log(`Running ${harnesses.length} harness(es).\n`);

const results = [];
for (const h of harnesses) {
  process.stdout.write(`  ${h.padEnd(26)}`);
  const out = spawnSync(process.execPath, [join(here, h)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const passes = (text.match(/^PASS/gm) ?? []).length;
  const fails = (text.match(/^FAIL/gm) ?? []).length;
  const ok = out.status === 0;
  results.push({ h, ok, passes, fails, text });
  console.log(ok ? `ok (${passes} checks)` : `FAILED (${fails} failed of ${passes + fails})`);
}

const broken = results.filter((r) => !r.ok);
if (broken.length > 0) {
  console.log('\nFailures:\n');
  for (const r of broken) {
    console.log(`  ${r.h}`);
    // The failing check lines, and nothing else: a Playwright stack trace
    // about a locator is never the reason.
    const lines = r.text.split('\n').filter((l) => /^FAIL|^Error:|ERR_[A-Z_]+/.test(l));
    for (const l of lines.slice(0, 6)) console.log(`      ${l.trim()}`);
    console.log('');
  }
}

const total = results.reduce((n, r) => n + r.passes, 0);
console.log(
  `\n${results.length - broken.length}/${results.length} harnesses passed, ${total} checks.`,
);
process.exit(broken.length === 0 ? 0 : 1);
