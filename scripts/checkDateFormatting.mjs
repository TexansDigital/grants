/**
 * Every date formatter call site has to say which kind of date it is.
 *
 * TWO KINDS, and they are not interchangeable:
 *
 *   formatCalendarDay(iso)            a day on a calendar. `2026-10-22` means
 *                                     that day everywhere on earth.
 *   formatDayInZone(iso, timeZone)    an instant, read in somebody's zone.
 *
 * Using the second on the first renders it A DAY EARLY: JavaScript parses a
 * date-only string as UTC midnight, and UTC midnight in Central is the
 * previous evening. Same for a date stored as `...T00:00:00.000Z`, which is
 * what `parseImportDate` writes. It is wrong every day of the year, CST and
 * CDT alike -- not a daylight-saving edge.
 *
 * IT REACHED A GRANTEE. On 2026-10-08 a reminder went out reading "October 21,
 * 2026. Due in 14 days." about a report due `2026-10-22`: the date and the
 * count disagreeing inside one sentence, and both disagreeing with the
 * compliance desk, which said October 22.
 *
 * WHY A CHECK AND NOT ONLY A TEST. A unit test pins the formatter's behaviour
 * and a content test pins one letter. Neither stops the NEXT call site picking
 * the wrong one -- and the wrong one looks more thorough, because it mentions
 * a timezone. So the set of call sites is enumerated here, each classified
 * with its reason, and an unlisted one fails until somebody classifies it.
 * The decision is forced at the moment it is made.
 *
 * This lives in a script rather than a test because the suite runs in the
 * Workers pool, where `?raw` imports come back as an empty string -- the way
 * the CSS check passed against nothing before it moved out here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every call site, and why it is the kind it is.
 *
 * `calendar` means the value is a day somebody chose. `instant` means it is a
 * moment the system computed, which the reader should see in their own zone.
 */
const SITES = [
  {
    file: 'src/lib/reportReminders.ts',
    kind: 'calendar',
    why:
      '`report_periods.due_date` is a plain YYYY-MM-DD typed into a date field. ' +
      'This is the one that reached a grantee reading a day early.',
  },
  {
    file: 'src/lib/decisionComms.ts',
    kind: 'calendar',
    why:
      '`awards.announcement_date` is an embargo date, stored by parseImportDate as ' +
      'UTC midnight. A grantee told to hold until the 20th when the embargo is the ' +
      '21st breaks it a day early, publicly.',
  },
  {
    file: 'src/lib/retention.ts',
    kind: 'instant',
    why:
      '`purge_due_at` is computed from a real moment by strftime. The Foundation ' +
      'should read it in their own zone.',
  },
  {
    file: 'src/lib/applicantRoutes.ts',
    kind: 'instant',
    why:
      '`cycles.decision_due_at` is a real instant: the cycle form takes a Central ' +
      'wall time and stores the UTC instant it names.',
  },
];

const CALENDAR = /\bformatCalendarDay\s*\(/;
const IN_ZONE = /\bformatDayInZone\s*\(/;

const problems = [];

/** Every .ts under src/, so a new call site cannot appear unnoticed. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const scanned = new Set(SITES.map((s) => s.file));
const all = walk(join(root, 'src'))
  .filter((f) => {
    // The definitions themselves live in time.ts and are not call sites.
    if (f.endsWith(`${'time'}.ts`) && f.includes(join('src', 'lib'))) return false;
    const text = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return CALENDAR.test(text) || IN_ZONE.test(text);
  })
  .map((f) => relative(root, f));

for (const file of all) {
  if (!scanned.has(file)) {
    problems.push(
      `${file} formats a date and is not classified in scripts/checkDateFormatting.mjs.\n` +
        '    Decide which kind it is -- a day somebody chose, or a moment the system\n' +
        '    computed -- and add it to SITES with the reason.',
    );
  }
}

for (const site of SITES) {
  let text;
  try {
    text = readFileSync(join(root, site.file), 'utf8');
  } catch {
    problems.push(`${site.file} is listed but does not exist.`);
    continue;
  }
  // Comments mention both names; only a CALL counts.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const callsCalendar = CALENDAR.test(code);
  const callsInZone = IN_ZONE.test(code);

  if (site.kind === 'calendar' && callsInZone) {
    problems.push(
      `${site.file} calls formatDayInZone, but its date is a CALENDAR DAY.\n` +
        `    ${site.why}\n` +
        '    Use formatCalendarDay. See src/lib/time.ts.',
    );
  }
  if (site.kind === 'instant' && callsCalendar) {
    problems.push(
      `${site.file} calls formatCalendarDay, but its date is an INSTANT.\n` +
        `    ${site.why}\n` +
        '    Use formatDayInZone.',
    );
  }
  if (!callsCalendar && !callsInZone) {
    problems.push(
      `${site.file} is listed here but no longer formats a date. Remove it from SITES.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`check:dates — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`check:dates — ok, ${SITES.length} call site(s) classified.`);
