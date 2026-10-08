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
 *
 * AND IT COVERS `web/` TOO, since 2026-10-08, because the first version of
 * this check did not and that was how it got caught being too narrow. The
 * Worker was swept, the admin screens were not, and FOUR of them were
 * rendering a calendar day in whatever zone the staff member's browser was
 * in: the payment ledger (a payment due the 1st shown as the 31st), the award
 * amendment trail (a term starting 2026-01-01 shown as 12/31/2025, the wrong
 * YEAR, on the record of a change to a grant), the decision desk (the embargo
 * date, which is the one the letter quotes) and the paperwork panel.
 *
 * The web rule is a ban rather than an enumeration. `web/src/` has eighteen
 * modules that show a date and gains one whenever a screen does; listing them
 * all would be maintenance without judgement. What actually distinguishes the
 * four bugs from the fourteen correct files is simple and mechanical: the
 * bugs called `toLocaleDateString` directly instead of going through a helper
 * that had already decided the question. So that call is banned outside the
 * module that defines the helpers.
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

/*
 * THE WEB HALF. One rule: a date is formatted through a named helper, never
 * by calling toLocaleDateString on the spot.
 *
 * `web/src/reportWording.ts` defines them -- formatDay and formatDayShort for
 * a calendar day (UTC), formatMoment, formatMomentShort and formatWhen for an
 * instant (Central) -- and is the one file allowed to make the call itself.
 *
 * toLocaleTimeString is NOT banned: the "saved at 9:30" stamps in
 * FormRenderer and draftSync are a clock for the person typing, which is
 * correctly their own, and has nothing to do with this bug.
 */
const WEB_HELPERS = 'web/src/reportWording.ts';
const BARE_DATE = /\.toLocaleDateString\s*\(/;

const webFiles = walk(join(root, 'web', 'src')).map((f) => relative(root, f));
let webUsing = 0;

for (const file of webFiles) {
  const text = readFileSync(join(root, file), 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\bformat(Day|Moment|When)\w*\s*\(/.test(code)) webUsing += 1;
  if (file === WEB_HELPERS || !BARE_DATE.test(code)) continue;
  problems.push(
    `${file} calls toLocaleDateString directly.\n` +
      '    Formatting a date on the spot is how four admin screens came to render a\n' +
      '    calendar day a day early. Use a helper from ' +
      `${WEB_HELPERS}, which\n` +
      '    has already decided whether the value is a calendar day or an instant:\n' +
      '      formatDay / formatDayShort      a day somebody chose     (UTC)\n' +
      '      formatMoment / formatMomentShort / formatWhen  a moment  (Central)\n' +
      '    If the value is neither, add a helper there rather than an exception here.',
  );
}

if (problems.length > 0) {
  console.error(`check:dates — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(
  `check:dates — ok, ${SITES.length} worker call site(s) classified, ` +
    `${webUsing} web module(s) formatting dates through a helper.`,
);
