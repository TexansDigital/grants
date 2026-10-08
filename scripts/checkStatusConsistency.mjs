/**
 * Nothing listed as settled may be re-opened in the blocking section.
 *
 * WHAT HAPPENED. On 2026-10-08 `docs/STATUS.md` grew the line "Worth doing
 * before the real send regardless: **add Resend to SPF.**" Two hundred lines
 * below, in the same file, under the heading "Finished and verified, so
 * neither of us re-opens it", it already said SPF and DKIM both pass and are
 * aligned. `docs/BLOCKED-ON-YOU.md` had recorded the DNS done and verified
 * three weeks earlier. The message headers said `spf=pass`.
 *
 * So the Foundation was told to go and change DNS that was already correct,
 * by a document that contained the refutation. That file's own first paragraph
 * warns about exactly this: "a status file that nobody can re-verify becomes
 * fiction within a week".
 *
 * WHAT THIS CHECKS. For each settled topic below, every sentence in the
 * blocking section is read. A sentence that names the topic AND tells somebody
 * to do something about it fails the check.
 *
 * Both halves are required on purpose. The blocking section is allowed to
 * discuss a settled topic -- it currently quotes the very headers that prove
 * this one -- it just may not issue work about it. "SPF for Resend is
 * published on rsend." passes. "Add Resend to SPF" does not.
 *
 * TO RE-OPEN SOMETHING, move it out of "What is already done" first. That is
 * the point: re-opening becomes an act somebody performs deliberately rather
 * than a sentence that slips in.
 *
 * Each topic also asserts its own marker is still present in the settled
 * section, so deleting an entry there without removing it here is caught too
 * -- otherwise this check quietly guards nothing.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * An argument overrides the file, so this check can be pointed at an older
 * revision to confirm it still catches what it was written for. It was
 * validated that way against 8cde654, the commit that carried the mistake.
 */
const FILE = process.argv[2] ?? 'docs/STATUS.md';

const BLOCKING = 'Blocking right now';
const SETTLED = 'What is already done';

/**
 * A settled topic, the words that name it, and the marker that has to still be
 * in the settled section for this entry to mean anything.
 */
const TOPICS = [
  {
    topic: 'email authentication',
    marker: '**Email deliverability.**',
    keywords: ['SPF', 'DKIM', 'DMARC'],
    why:
      'SPF, DKIM and DMARC all pass and are aligned, verified in the headers of a ' +
      'message delivered 2026-10-08. SPF for Resend lives on the rsend. subdomain, ' +
      'which is the envelope sender; the root record is Cloudflare Email Routing\'s ' +
      'and is not consulted.',
  },
  {
    topic: 'the production cutover runbook',
    marker: '**The cutover runbook**',
    keywords: ['cutover runbook'],
    why: 'docs/PRODUCTION-CUTOVER.md exists, six phases, each with a verification.',
  },
];

/** Telling somebody to do something, as whole words. Tense matters: */
/** "publish X" is an instruction, "X is published" is a fact. */
const IMPERATIVES = [
  'add', 'fix', 'set', 'change', 'merge', 'publish', 'update', 'enable',
  'configure', 'needs', 'need', 'must', 'should', 'remove', 'correct',
];

const text = readFileSync(resolve(root, FILE), 'utf8');

/** The body of a `## ` section, up to the next `## `. */
function section(title) {
  const start = text.indexOf(`## ${title}`);
  if (start === -1) return null;
  const after = text.indexOf('\n## ', start + 1);
  return text.slice(start, after === -1 ? text.length : after);
}

const blocking = section(BLOCKING);
const settled = section(SETTLED);

const problems = [];

if (blocking === null) problems.push(`${FILE} has no "## ${BLOCKING}" section.`);
if (settled === null) problems.push(`${FILE} has no "## ${SETTLED}" section.`);

if (blocking !== null && settled !== null) {
  // Fenced blocks are evidence pasted in, not prose. Drop them.
  const prose = blocking.replace(/```[\s\S]*?```/g, ' ');

  // Markdown hard-wraps, so rejoin each paragraph before splitting sentences.
  const sentences = prose
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' '))
    .flatMap((p) => p.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const t of TOPICS) {
    if (!settled.includes(t.marker)) {
      problems.push(
        `${t.topic}: the marker ${JSON.stringify(t.marker)} is no longer in "${SETTLED}".\n` +
          '    Either it moved -- in which case remove this topic from\n' +
          '    scripts/checkStatusConsistency.mjs -- or the settled entry was lost.',
      );
      continue;
    }
    for (const sentence of sentences) {
      const named = t.keywords.find((k) =>
        new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence),
      );
      if (!named) continue;
      const told = IMPERATIVES.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(sentence));
      if (!told) continue;
      problems.push(
        `"${BLOCKING}" tells somebody to ${told} something about ${t.topic}, which\n` +
          `    "${SETTLED}" records as finished:\n\n` +
          `      ${sentence}\n\n` +
          `    ${t.why}\n` +
          `    If it genuinely needs re-opening, move it out of "${SETTLED}" first.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`check:status — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`check:status — ok, ${TOPICS.length} settled topic(s) still settled.`);
