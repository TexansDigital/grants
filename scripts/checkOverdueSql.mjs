/**
 * Every SQL query that asks "is this report overdue" asks it the same way.
 *
 * THE RULE, which src/lib/reportDue.ts already states in prose: bind
 * `today(nowIso)` and compare `substr(due_date, 1, 10) < ?`. Both sides are
 * then plain YYYY-MM-DD and the comparison cannot diverge from `daysUntil`.
 *
 * WHY A BAN AND NOT A TEST. Due dates are stored two ways -- a plain
 * '2026-10-22', which is what the past-grantee ask writes, and midnight UTC
 * from parseImportDate -- and BOTH sort before any same-day timestamp. So
 * `due_date < <full ISO instant>` calls a report due TODAY overdue, from a
 * millisecond after midnight.
 *
 * This happened twice. An earlier sweep fixed three sites (awardPage,
 * organizationPage twice) and missed src/lib/dashboard.ts, which is the
 * Results screen -- the number that goes in a board paper. It survived 1887
 * green tests because the dashboard's own tests used plus or minus 30 days:
 * they pinned the SIGN and never the BOUNDARY.
 *
 * A fourth site is what this exists to catch. Rereading the three that were
 * right is not what would have found the fourth.
 *
 * NOT BANNED: equality (`due_date = ?`, the optimistic lock in reportAdmin),
 * ORDER BY, and anything inside substr() -- those are the correct form.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The module that defines the rule may describe the wrong form in prose. */
const DEFINES_THE_RULE = 'src/lib/reportDue.ts';

/** `due_date` compared with < or > and NOT wrapped in substr(). */
const BARE_COMPARE = /(?<!substr\s*\(\s*)\b(?:\w+\.)?due_date\s*(?:<|>)=?\s*\?/g;
/** The correct form, counted so the check can report the census. */
const GUARDED = /substr\s*\(\s*(?:\w+\.)?due_date\s*,\s*1\s*,\s*10\s*\)\s*(?:<|>)=?\s*\?/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const problems = [];
let guarded = 0;

for (const full of walk(join(root, 'src'))) {
  const file = relative(root, full);
  if (file === DEFINES_THE_RULE) continue;

  const text = readFileSync(full, 'utf8');
  // Comments discuss the wrong form on purpose. Only real SQL counts.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  guarded += (code.match(GUARDED) ?? []).length;

  for (const hit of code.match(BARE_COMPARE) ?? []) {
    problems.push(
      `${file} compares due_date directly:  ${hit.trim()}\n` +
        '    A due date is stored as a plain YYYY-MM-DD or as midnight UTC, and both\n' +
        '    sort BEFORE any same-day timestamp -- so this calls a report due today\n' +
        '    overdue from a millisecond past midnight, while the compliance desk\n' +
        '    says it is current.\n' +
        '    Write:  substr(due_date, 1, 10) < ?   and bind today(nowIso).\n' +
        `    See ${DEFINES_THE_RULE}, which states the rule.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`check:overdue — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`check:overdue — ok, ${guarded} overdue comparison(s), all on the calendar day.`);
