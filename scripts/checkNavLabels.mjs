/**
 * No document may send a reader to a Steward menu that was renamed away.
 *
 * WHAT HAPPENED. The nav was renamed on 2026-10-07 -- Pipeline became
 * Applications, Dashboard became Results, Configuration became Programs and
 * moved behind a "More" menu. STATUS.md recorded the rename. Six other
 * documents kept the old names, and one of them was the production cutover
 * runbook. A new Grants Coordinator, told to open "Configuration", lost about
 * an hour before finding web/src/Shell.tsx -- which is the one file the reader
 * cannot be expected to read.
 *
 * Claude also gave the old labels from memory twice after the rename, and was
 * corrected by a screenshot both times.
 *
 * WHY THIS SHAPE. The first version of this check flagged any "Word ->" in
 * docs/ and produced twenty-three false positives: Cloudflare dashboard paths,
 * Resend menus, data-flow arrows in the threat model. A check that cries wolf
 * gets switched off, so it bans the SPECIFIC retired names instead. That is
 * the class that actually occurred, and it cannot fire on somebody else's
 * menu.
 *
 * The replacements are verified against NAV_ITEMS in Shell.tsx on every run,
 * so this file cannot quietly recommend a name that has itself been renamed.
 *
 * One more narrowing was needed after that: "Dashboard" is a generic word, and
 * three documents say "Cloudflare dashboard ->". Somebody else's dashboard is
 * not this one, so a retired name carrying another product's name in front of
 * it is skipped. That list is explicit rather than clever, for the same reason
 * the ban is.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Retired label -> what it is now, and where it lives. */
const RETIRED = {
  Configuration: { now: 'Programs', where: 'behind More, at /configuration' },
  Pipeline: { now: 'Applications', where: 'at /pipeline' },
  Dashboard: { now: 'Results', where: 'at /dashboard' },
};

const shell = readFileSync(join(root, 'web/src/Shell.tsx'), 'utf8');
const labels = new Set([...shell.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]));

const problems = [];

/* The map must stay honest: every replacement has to still be on the screen. */
for (const [old, { now }] of Object.entries(RETIRED)) {
  if (!labels.has(now)) {
    problems.push(
      `scripts/checkNavLabels.mjs says "${old}" is now "${now}", and "${now}" is not in\n` +
        '    NAV_ITEMS any more. The nav was renamed again; update RETIRED here first.',
    );
  }
}

for (const file of readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join(root, 'docs', file), 'utf8');
  text.split('\n').forEach((line, i) => {
    // A line recording the rename has to be able to say the old name.
    if (/renamed|was called|used to be|no longer/i.test(line)) return;
    for (const [old, { now, where }] of Object.entries(RETIRED)) {
      // Only a NAVIGATION reference: followed by an arrow, or called a screen.
      const nav = new RegExp(
        `\\b${old}\\b\\s*(?:→|->)|\\bthe\\s+${old}\\b\\s*(?:screen|page|tab|section|menu)`,
        'gi',
      );
      /* Somebody else's dashboard is not this one. */
      const OTHERS = /\b(cloudflare|resend|eloqua|zero trust|google|microsoft|aws|formstack)\s+$/i;
      let isOurs = false;
      for (const hit of line.matchAll(nav)) {
        if (!OTHERS.test(line.slice(Math.max(0, hit.index - 24), hit.index))) isOurs = true;
      }
      if (!isOurs) continue;
      problems.push(
        `docs/${file}:${i + 1} sends the reader to "${old}", renamed to "${now}" on 2026-10-07.\n` +
          `    It is now ${where}.\n` +
          '    Write the URL as well as the label -- a label can be renamed again,\n' +
          '    and a URL in a document is what survives it.',
      );
    }
  });
}

if (problems.length > 0) {
  console.error(`check:nav — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log(
  `check:nav — ok, ${Object.keys(RETIRED).length} retired label(s) absent from docs/, ` +
    `${labels.size} live nav label(s).`,
);
