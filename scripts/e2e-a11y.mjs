/**
 * Every screen a nonprofit can reach, run through axe-core in a real browser.
 *
 *   npm run e2e:a11y
 *
 * WHY THIS EXISTS. CLAUDE.md sets WCAG 2.1 AA as the target and says plainly
 * that accessibility is not optional here: "This is a form nonprofits are
 * required to use to receive money." Up to now that target was served by
 * writing careful markup and never checking it. Careful markup is a claim. A
 * run is evidence.
 *
 * WHAT IT PROVES. Every rule axe-core implements for wcag2a, wcag2aa, wcag21a
 * and wcag21aa, evaluated against the real rendered DOM of each screen, in
 * both themes where a screen has two -- plus a handful of keyboard and focus
 * behaviours axe cannot see and that are specific to a long form: that the
 * error summary moves focus, that the save-state indicator announces, and that
 * every section is reachable from the keyboard alone.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving. Automated
 * tooling catches somewhere between a third and a half of real barriers. It
 * cannot tell you whether a label makes sense, whether an error message is
 * actionable, whether the reading order matches the visual order, or what any
 * of this sounds like in VoiceOver or NVDA. A green run here means the
 * mechanical faults are gone. It does not mean the form is usable by a blind
 * applicant, and nobody should say that it does until a human with a screen
 * reader has sat down with it.
 *
 * PREREQUISITES: `npm run dev` on 8787 and `npm run dev:web` on 5173, against
 * a local database migrated and seeded. Invented data only, written to the
 * local preview database.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const WEB = process.env.STEWARD_WEB ?? 'http://127.0.0.1:5173';
const BROWSER =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** axe-core ships one UMD file. Resolve it rather than guessing the path. */
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/**
 * The rule sets. WCAG 2.1 AA is the stated target, so those four tags and no
 * others: axe also ships "best-practice" rules, and mixing advice in with the
 * standard is how a real AA failure gets lost in a list of suggestions.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

let failures = 0;
/** Every rule that returned a verdict, across every screen. */
const rulesRun = new Set();
/** Checks axe declined to decide. Not failures, and not passes either. */
const undecided = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};
const note = (label, value) => console.log(`      ${label}: ${value}`);

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', '--local', '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}
function one(statement, column) {
  const rows = sql(statement);
  if (rows.length === 0) throw new Error(`no rows for: ${statement}`);
  return rows[0][column];
}

function sessionsNamespaceId() {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const block = toml.split('[[kv_namespaces]]').find((b) => /binding\s*=\s*"SESSIONS"/.test(b));
  const id = block && /\bid\s*=\s*"([^"]+)"/.exec(block)?.[1];
  if (!id) throw new Error('could not find the SESSIONS namespace id in wrangler.toml');
  return id;
}

function mintSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const key = `session:${createHash('sha256').update(token).digest('hex')}`;
  const file = join(mkdtempSync(join(tmpdir(), 'steward-a11y-')), 'session.json');
  writeFileSync(
    file,
    JSON.stringify({
      userId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
  );
  execFileSync(
    'npx',
    ['wrangler', 'kv', 'key', 'put', key, `--path=${file}`,
     `--namespace-id=${sessionsNamespaceId()}`, '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return token;
}

/**
 * Run axe against whatever is on screen and report every violation.
 *
 * REPORTED PER NODE, not per rule. "color-contrast: 7 nodes" is a number you
 * cannot act on; the selector and the failure summary are what someone fixing
 * it needs, and there are never so many that printing them is a problem --
 * if there are, that is itself the finding.
 */
async function audit(page, screen) {
  await page.addScriptTag({ path: AXE_PATH });
  const result = await page.evaluate(
    async (tags) => await window.axe.run(document, { runOnly: { type: 'tag', values: tags } }),
    TAGS,
  );
  const violations = result.violations.flatMap((v) =>
    v.nodes.map((n) => ({
      rule: v.id,
      impact: n.impact ?? v.impact,
      target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
      why: (n.failureSummary ?? '').split('\n').filter(Boolean).slice(1).join(' ').slice(0, 160),
    })),
  );
  const ok = violations.length === 0;
  if (!ok) failures += 1;
  /*
   * THE ELEMENT COUNT IS PART OF THE RESULT, not decoration. axe reports zero
   * violations against an empty page just as cheerfully as against a clean
   * one, and "0 violations" on a screen that rendered nothing is a false
   * green light of exactly the kind CLAUDE.md forbids. Printing what was
   * actually on screen is what lets a reader tell the two apart.
   */
  const elements = await page.evaluate(() => document.querySelectorAll('main *').length);
  /*
   * INCOMPLETE IS NOT PASSED. axe returns a third bucket for checks it could
   * not decide -- most often contrast against a background it cannot compute,
   * such as text over an image or a gradient. Folding those into a clean
   * result is how a real contrast failure hides behind a green run, so they
   * are surfaced as something a human still has to look at, and counted.
   */
  for (const v of result.incomplete) {
    for (const n of v.nodes) {
      undecided.push({ screen, rule: v.id, target: [n.target].flat().join(' ') });
    }
  }
  for (const r of result.passes) rulesRun.add(r.id);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${screen} — ${elements} elements, ${result.passes.length} rules passed, ` +
      `${violations.length} violation${violations.length === 1 ? '' : 's'}`,
  );
  if (elements < 10) {
    failures += 1;
    console.log(`        FAIL  only ${elements} elements rendered — this audit proves nothing`);
  }
  for (const v of violations) {
    console.log(`        [${v.impact}] ${v.rule}`);
    console.log(`          at  ${v.target}`);
    if (v.why) console.log(`          why ${v.why}`);
  }
  return violations;
}

console.log('Steward — accessibility sweep (axe-core, WCAG 2.1 AA)\n');

// --- fixtures ---------------------------------------------------------------
// Invented throughout. EINs begin 00, not an assignable IRS prefix, so a
// fixture can never collide with a real organization.
const ids = {
  org: randomUUID(), applicant: randomUUID(), grantee: randomUUID(),
  cycle: randomUUID(), app: randomUUID(), award: randomUUID(), period: randomUUID(),
};
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
const ein = `00${stamp}0`;
if (ein.length !== 9) throw new Error(`fixture EIN must be nine digits, got ${ein}`);

const appFormId = one(
  `SELECT fd.id FROM form_definitions fd
     JOIN program_stages ps ON ps.id = fd.stage_id
    WHERE fd.kind='application' AND fd.status='published'
    ORDER BY ps.sort_order DESC, fd.version DESC LIMIT 1`, 'id');
const eligibilityFormId = one(
  `SELECT fd.id FROM form_definitions fd
     JOIN program_stages ps ON ps.id = fd.stage_id
    WHERE fd.kind='application' AND fd.status='published'
    ORDER BY ps.sort_order ASC, fd.version DESC LIMIT 1`, 'id');
const stageId = one(`SELECT stage_id AS id FROM form_definitions WHERE id='${appFormId}'`, 'id');
const programId = one(`SELECT program_id AS id FROM form_definitions WHERE id='${appFormId}'`, 'id');
const eligibilityStageId = one(
  `SELECT stage_id AS id FROM form_definitions WHERE id='${eligibilityFormId}'`, 'id');

sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${ids.org}','Invented Bayou Alliance ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.applicant}','a11y-applicant-${stamp}@example-invented.org','applicant',
             '${ids.org}',1,'${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.grantee}','a11y-grantee-${stamp}@example-invented.org','grantee',
             '${ids.org}',1,'${now}','${now}')`);
sql(`INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
     VALUES ('${ids.cycle}','${programId}','A11y ${stamp}','2020-01-01T00:00:00.000Z',
             '2099-01-01T00:00:00.000Z','open','${now}','${now}')`);
sql(`INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
                               status, created_at, updated_at)
     VALUES ('${ids.app}','${ids.cycle}','${stageId}','${ids.org}','${appFormId}','draft',
             '${now}','${now}')`);

/*
 * A DECIDED, COMMUNICATED APPLICATION BEHIND THE AWARD.
 *
 * The first version of this fixture made a bare imported award with
 * is_public = 1 and expected it on /grants. It never appeared, and the page
 * audited six elements. That was publicGrants working exactly as written: it
 * INNER JOINs applications and requires decision_communicated_at, so an
 * imported record whose grantee this system never wrote to cannot be
 * published on a condition that cannot be evaluated. The fixture was wrong,
 * not the query -- and a harness that audits an empty page is the false green
 * light this whole sweep exists to avoid.
 */
const decidedAppId = randomUUID();
/*
 * ITS OWN, EARLIER CYCLE. An organization may hold one application per cycle
 * and a trigger enforces it -- so putting the funded application in the same
 * cycle as the draft one this sweep drives is refused outright. A past cycle
 * is also the truthful shape: the grant on the public list was awarded last
 * year, not out of the cycle that is open now.
 */
const pastCycleId = randomUUID();
sql(`INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
     VALUES ('${pastCycleId}','${programId}','A11y past ${stamp}','2024-01-01T00:00:00.000Z',
             '2024-06-01T00:00:00.000Z','closed','${now}','${now}')`);
/*
 * An admin to be `decided_by`. Created rather than looked up: applications
 * carries CHECK ((decided_at IS NULL) = (decided_by IS NULL)), and a fresh
 * local database has no staff rows at all -- so looking one up made this
 * script die before it opened a browser.
 */
const staffId = randomUUID();
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${staffId}','a11y-admin-${stamp}@example-invented.org','admin',NULL,1,
             '${now}','${now}')`);
sql(`INSERT INTO applications
       (id, cycle_id, stage_id, organization_id, form_definition_id, status,
        project_title, requested_amount_cents, submitted_at, decided_at, decided_by,
        decision_communicated_at, decision_communicated_by, decision_communicated_via,
        created_at, updated_at)
     VALUES ('${decidedAppId}','${pastCycleId}','${stageId}','${ids.org}','${appFormId}','awarded',
             'Neighborhood Reading Rooms',2500000,'${now}','${now}','${staffId}',
             '${now}','${staffId}','email','${now}','${now}')`);

// An award and an open report period, so the grantee portal has something on
// it. A portal with nothing due renders an empty state and audits almost
// nothing, which would be a pass that means nothing.
const reportFormId = sql(
  `SELECT id FROM form_definitions
    WHERE program_id='${programId}' AND kind='report' AND status='published'
      AND deleted_at IS NULL LIMIT 1`)[0]?.id;
sql(`INSERT INTO awards
       (id, application_id, organization_id, program_id, awarded_amount_cents, awarded_at,
        status, term_start, term_end, is_public, created_at, updated_at)
     VALUES ('${ids.award}','${decidedAppId}','${ids.org}','${programId}',2500000,'${now}',
             'active','2025-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z',
             1,'${now}','${now}')`);
if (reportFormId) {
  sql(`INSERT INTO report_periods
         (id, award_id, form_definition_id, label, period_type, period_start, period_end,
          opens_at, due_date, status, created_at, updated_at)
       VALUES ('${ids.period}','${ids.award}','${reportFormId}','Final report','final',
               '2025-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z','2020-01-01T00:00:00.000Z',
               '2099-03-31T00:00:00.000Z','open','${now}','${now}')`);
}
note('application', ids.app);
note('award', ids.award);
note('report form', reportFormId ?? 'none — the report screen will be skipped');

const applicantToken = mintSession(ids.applicant);
const granteeToken = mintSession(ids.grantee);

// --- drive ------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });

/** A context with no session: this is what the public actually arrives as. */
const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });

async function withSession(token, viewport) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1280, height: 900 } });
  await ctx.addCookies([{
    name: '__Host-steward_session', value: token,
    domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
  }]);
  // Uploads must not leave this machine, and a hung PUT would stall the sweep.
  await ctx.route(
    (url) => url.hostname.endsWith('.r2.cloudflarestorage.com'),
    (route) => route.fulfill({ status: 200, body: '' }),
  );
  return ctx;
}

async function open(ctx, path) {
  const page = await ctx.newPage();
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return page;
}

const found = [];

console.log('\n  Public, no session:\n');
for (const [label, path] of [
  ['the open-cycles page', '/apply'],
  ['the sign-in page', '/sign-in'],
  ['the sign-in page after an expired link', '/sign-in?expired=1'],
  ['the public grants list', '/grants'],
  ['the eligibility screen', `/apply/start/${ids.cycle}`],
  /*
   * The past-grantee page. Public, unauthenticated, and the first Steward
   * screen a nonprofit that was funded years ago will ever see -- which makes
   * it exactly the page that should not have been missing from this list. It
   * was, until today.
   */
  ['the past-grantee page', '/tell-us'],
]) {
  const page = await open(anon, path);
  found.push(...(await audit(page, label)));
  await page.close();
}

console.log('\n  The application, section by section:\n');
const applicantCtx = await withSession(applicantToken);
const form = await open(applicantCtx, `/apply/${ids.app}`);
/*
 * BY INDEX, NOT BY NAME. Each section button carries its step number in a
 * child span, so its accessible name is "1\nPrimary contact" -- which is
 * correct for a screen reader and useless as a Playwright selector.
 */
const sectionNav = form.locator('nav button, .section-nav button');
const sectionCount = await sectionNav.count();
const sectionNames = (await sectionNav.allInnerTexts()).map((t) =>
  t.replace(/\s+/g, ' ').replace(/^\d+\s*/, '').trim());
note('sections', sectionNames.length > 0 ? sectionNames.join(' | ') : 'none found');
found.push(...(await audit(form, 'the application, as it opens')));
for (let i = 0; i < sectionCount; i += 1) {
  await sectionNav.nth(i).click();
  await form.waitForTimeout(350);
  found.push(...(await audit(form, `the application — ${sectionNames[i]}`)));
}

/*
 * THE ERROR STATE, which is the one an applicant who is struggling sees.
 *
 * Submitting an empty application is the fastest way to render the required-
 * field summary, and a summary nobody can reach is worse than no summary: the
 * applicant is told something is wrong and given no way to find it.
 */
console.log('\n  The application, refusing an empty submit:\n');
const submit = form.getByRole('button', { name: /Submit application/ });
if (await submit.count()) {
  await submit.first().click();
  await form.waitForTimeout(900);
  found.push(...(await audit(form, 'the application — required-field summary')));
  /*
   * FOCUS, NOT A LIVE REGION, and that is deliberate.
   *
   * This check first asserted role="alert" and failed. The code is right and
   * the assertion was wrong: GOV.UK dropped role="alert" from its error
   * summary precisely because a live region PLUS a focus move makes a screen
   * reader say the whole thing twice. The contract that actually serves a
   * blind applicant is the one below -- a focusable container carrying its own
   * accessible name, with focus moved into it, so the count is announced once
   * and the person is standing where the list is.
   */
  const announced = await form.evaluate(() => {
    const el = document.activeElement?.closest('.summary');
    if (!el) return { focused: false };
    const labelId = el.getAttribute('aria-labelledby');
    const label = labelId ? document.getElementById(labelId)?.textContent?.trim() : null;
    return {
      focused: true,
      focusable: el.getAttribute('tabindex') === '-1',
      named: !!label && label.length > 0,
      saysHowMany: !!label && /\d/.test(label),
      notAlsoALiveRegion: el.getAttribute('role') !== 'alert' && !el.hasAttribute('aria-live'),
    };
  });
  check('the refusal is announced by taking focus to a named summary',
    announced,
    { focused: true, focusable: true, named: true, saysHowMany: true, notAlsoALiveRegion: true });
  const anchors = await form.locator('.summary a, .summary button').count();
  check('every outstanding item offers a way to get to the field',
    anchors > 0 && anchors === (await form.locator('.summary li').count()), true);
}

/*
 * THE PAST-GRANTEE PAGE, REFUSING AN EMPTY SUBMIT.
 *
 * Audited in its error state for the same reason the application is: the
 * person who most needs this to work is the one who has already got it wrong
 * once. This page also has no autosave and no draft, so somebody who cannot
 * find the field being complained about has no way back at all -- they close
 * the tab, and the Foundation never hears from them.
 */
console.log('\n  The past-grantee page, refusing an empty submit:\n');
{
  const claim = await open(anon, '/tell-us');
  const send = claim.getByRole('button', { name: /Send|Submit|Tell us/i });
  if (await send.count()) {
    await send.first().click();
    await claim.waitForTimeout(900);
    found.push(...(await audit(claim, 'the past-grantee page — refusal')));

    // Same contract as the application's summary. Stated once, checked in both
    // places, because two pages disagreeing about how a refusal is announced
    // is worse for a screen reader than either choice made consistently.
    const announced = await claim.evaluate(() => {
      const el = document.activeElement?.closest('.summary');
      if (!el) return { focused: false };
      const labelId = el.getAttribute('aria-labelledby');
      const label = labelId ? document.getElementById(labelId)?.textContent?.trim() : null;
      return {
        focused: true,
        focusable: el.getAttribute('tabindex') === '-1',
        named: !!label && label.length > 0,
        notAlsoALiveRegion: el.getAttribute('role') !== 'alert' && !el.hasAttribute('aria-live'),
      };
    });
    check('the refusal takes focus to a named summary, as the application does',
      announced, { focused: true, focusable: true, named: true, notAlsoALiveRegion: true });
  } else {
    check('there is a way to send the page', 'no submit control found', 'a submit control');
  }
  await claim.close();
}

/*
 * KEYBOARD ONLY. A section switcher that is drawn as buttons but reached only
 * by mouse is the classic version of this failure, and axe cannot see it --
 * the markup is impeccable and the tab order goes somewhere else.
 */
console.log('\n  Keyboard:\n');
await form.evaluate(() => document.body.focus());
const reached = await form.evaluate(async () => {
  const names = [];
  let guard = 0;
  const seen = new Set();
  while (guard < 400) {
    guard += 1;
    const el = document.activeElement;
    if (el && el !== document.body) {
      const key = `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 40)}:${names.length}`;
      if (seen.has(key)) break;
      seen.add(key);
      if (el.tagName === 'BUTTON' || el.tagName === 'A') names.push((el.textContent ?? '').trim());
    }
    const before = document.activeElement;
    // Synthetic Tab cannot move focus; walk the real tab order instead by
    // asking the browser for the next focusable element in document order.
    const focusables = [...document.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),' +
      'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )].filter((e) => e.offsetParent !== null || e === document.activeElement);
    const i = focusables.indexOf(before);
    const next = focusables[i + 1];
    if (!next) break;
    next.focus();
    if (document.activeElement === before) break;
  }
  return names;
});
const missed = sectionNames.filter((s) => s && !reached.some((r) => r.includes(s)));
check('every section of the form is reachable from the keyboard', missed, []);

/*
 * A REAL TAB PRESS, not element.focus().
 *
 * This check first called .focus() in the page and reported no focus ring,
 * which would have been a serious finding if it were true. It was not: the
 * ring is :focus-visible, and Chromium decides :focus-visible from the last
 * INPUT MODALITY. After a Playwright click, programmatic focus is treated as
 * mouse focus and the ring is correctly suppressed. Only a keyboard event
 * tests what a keyboard user sees, so this drives the actual key.
 */
await form.keyboard.press('Tab');
const ringed = [];
for (let i = 0; i < 25; i += 1) {
  const seen = await form.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const visible =
      (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
      (s.boxShadow !== 'none' && s.boxShadow !== '');
    return {
      what: `${el.tagName.toLowerCase()}${el.getAttribute('name') ? `[${el.getAttribute('name')}]` : ''}`,
      visible,
      matchesFocusVisible: el.matches(':focus-visible'),
    };
  });
  if (seen) ringed.push(seen);
  await form.keyboard.press('Tab');
}
const unringed = ringed.filter((r) => !r.visible).map((r) => r.what);
check('every control tabbed to shows a focus ring', unringed, []);
check('and the browser agrees they are keyboard-focused',
  ringed.length > 0 && ringed.every((r) => r.matchesFocusVisible), true);
note('controls tabbed through', ringed.length);

await applicantCtx.close();

console.log('\n  The grantee portal:\n');
const granteeCtx = await withSession(granteeToken, { width: 390, height: 844 });
const portal = await open(granteeCtx, '/reports');
found.push(...(await audit(portal, 'the portal, on a phone')));
const fileButton = portal.getByRole('link', { name: /report/i }).or(
  portal.getByRole('button', { name: /report/i }));
if (reportFormId) {
  const reportPage = await open(granteeCtx, `/reports/${ids.period}`);
  found.push(...(await audit(reportPage, 'the report form, on a phone')));
  await reportPage.close();
}
await portal.close();
await granteeCtx.close();
await anon.close();
await browser.close();

// --- what it adds up to -----------------------------------------------------
const byRule = new Map();
for (const v of found) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
console.log('\n  Violations by rule:');
if (byRule.size === 0) console.log('      none');
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
  console.log(`      ${String(n).padStart(3)}  ${rule}`);
}

console.log(`\n  ${rulesRun.size} axe rules returned a verdict, including:`);
/*
 * NAMED, not counted. "23 rules passed" is compatible with contrast never
 * having been evaluated at all -- which is exactly the failure this sweep
 * would be worst at noticing about itself.
 */
for (const key of ['color-contrast', 'label', 'button-name', 'link-name', 'aria-valid-attr-value',
                   'form-field-multiple-labels', 'select-name', 'frame-title']) {
  console.log(`      ${rulesRun.has(key) ? 'ran        ' : 'never ran  '} ${key}`);
}

console.log(`\n  Undecided by axe (a human has to look): ${undecided.length}`);
for (const u of undecided.slice(0, 20)) {
  console.log(`      ${u.rule} — ${u.screen} — ${u.target}`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('What this does NOT establish: axe catches roughly a third to a half of');
console.log('real barriers. It cannot judge whether a label makes sense, whether an');
console.log('error is actionable, or what any of this sounds like in a screen reader.');
console.log('A human with VoiceOver or NVDA still has to sit down with this form.');
/*
 * AND ONE SPECIFIC HOLE, named rather than left to be discovered. Preview has
 * no TURNSTILE_SITE_KEY, so the widget does not render here and its iframe is
 * never audited -- which is why frame-title reports as never having run. The
 * markup inside that frame is Cloudflare's, not ours, but it sits on the
 * public entry points and 2.4.1 applies to it all the same.
 */
console.log('');
console.log('Not covered at all: the Turnstile widget. Preview sets no site key, so');
console.log('its iframe never renders here — which is why frame-title never ran. That');
console.log('one has to be checked against the deployed public form.');
process.exit(failures === 0 ? 0 : 1);
