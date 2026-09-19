/**
 * The public front door, driven end to end in a real browser.
 *
 *   npm run e2e:apply
 *
 * WHAT IT COVERS: a nonprofit arriving with no link and no account finds an
 * open cycle, reads what applying involves, fails the eligibility screen when
 * they should, passes it when they should, and is told the same thing either
 * way about what happens next.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving:
 *   - No email is delivered. Preview has no RESEND_API_KEY, so every message
 *     is recorded and suppressed. This checks the ROW, not an inbox.
 *   - Turnstile is not exercised. Preview has no site key, so no widget
 *     renders and the server skips verification; production fails closed.
 *   - It is not a security review and not an accessibility test.
 *
 * PREREQUISITES: `npm run build:web`, then `npm run dev` on 8787, against a
 * local database migrated and seeded. Invented data only, local database only.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';
const BROWSER =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};
const truthy = (label, value) => {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};
const note = (label, value) => console.log(`      ${label}: ${value}`);

function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', '--local', '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

console.log('Steward — the public front door, end to end\n');

const stamp = Date.now().toString().slice(-6);
const ein = `00${stamp}0`;
if (ein.length !== 9) throw new Error(`fixture EIN must be nine digits, got ${ein}`);

// A cycle of this program, genuinely open. Its own cycle, so a re-run does not
// depend on the last one's leftovers.
const programId = sql(
  `SELECT id FROM programs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`)[0].id;
const programName = sql(`SELECT name FROM programs WHERE id='${programId}'`)[0].name;
const cycleId = randomUUID();
const now = new Date().toISOString();
const opens = new Date(Date.now() - 86_400_000).toISOString();
const closes = new Date(Date.now() + 12 * 86_400_000).toISOString();
sql(`INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
     VALUES ('${cycleId}','${programId}','Front door ${stamp}','${opens}','${closes}','open','${now}','${now}')`);
// Block over unfiled reports, so the warning on the card is exercised.
sql(`UPDATE programs SET compliance_policy='block' WHERE id='${programId}'`);
note('cycle', cycleId);

const browser = await chromium.launch({ executablePath: BROWSER });
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const notFound = [];
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

// ---- arriving with nothing -------------------------------------------------
await page.goto(`${APP}/apply`, { waitUntil: 'networkidle' });
await page.waitForSelector('.portal-award', { timeout: 10_000 });

check('the page names itself', await page.locator('h2').first().innerText(), 'Apply for a grant');
const card = page.locator('.portal-award').filter({ hasText: `Front door ${stamp}` });
truthy('the open cycle is listed', await card.count() > 0);

const cardText = await card.first().innerText();
truthy('the deadline counts down in days', /Closes in \d+ days/.test(cardText));
truthy('it says what the form asks, in counts', /\d+ questions/.test(cardText));
truthy('it warns up front about unfiled reports', cardText.includes('reports on previous grants'));
truthy('a privacy notice is on the entry page', (await page.innerText('.privacy')).includes('EIN'));
note('card', cardText.split('\n').slice(0, 4).join(' | '));

// ---- into the eligibility screen -------------------------------------------
await card.first().getByRole('button', { name: 'Start an application' }).click();
await page.waitForURL(`**/apply/start/${cycleId}`);
await page.waitForSelector('#field-organization_name', { timeout: 10_000 });
truthy('the eligibility form renders from the published definition',
  await page.locator('#field-ein').isVisible());
const eyebrow = await page.locator('.section-head .eyebrow').first().innerText();
note('eyebrow', eyebrow);
// Compared case-insensitively: the eyebrow is uppercased by CSS, and
// innerText returns what is rendered rather than what is in the DOM.
truthy('it names the program', eyebrow.toLowerCase().includes(programName.toLowerCase()));

// ---- it refuses an empty form, in the applicant's own words -----------------
await page.getByRole('button', { name: 'Check and send me a link' }).click();
await page.waitForSelector('.summary', { timeout: 5_000 });
const listed = await page.locator('.summary li').allInnerTexts();
truthy('an incomplete screen is refused with a list', listed.length > 0);
truthy('and it names questions, not field keys',
  listed.every((t) => !t.includes('_')));
check('nothing was created', sql(
  `SELECT COUNT(*) AS n FROM applications WHERE cycle_id='${cycleId}'`)[0].n, 0);

// ---- fill it in ------------------------------------------------------------
const email = `frontdoor-${stamp}@example-invented.org`;
await page.locator('#field-organization_name input').fill(`Invented Bayou Trust ${stamp}`);
await page.locator('#field-ein input').fill(ein);
await page.locator('#field-requested_amount input').fill('25,000');
await page.locator('#field-contact_first_name input').fill('Alex');
await page.locator('#field-contact_last_name input').fill('Moreno');
await page.locator('#field-contact_email input').fill(email);
for (const key of ['entity_type_confirmation', 'guidelines_attestation', 'authorization_attestation']) {
  await page.locator(`#field-${key} input[type=checkbox]`).check();
}
await page.locator('#field-counties_served input[value=harris]').check();

await page.getByRole('button', { name: 'Check and send me a link' }).click();
await page.waitForSelector('.portal-done', { timeout: 15_000 });

check('it confirms without claiming anything about eligibility',
  await page.locator('.portal-done h2').innerText(), 'Check your email');
truthy('and names the address it went to', (await page.innerText('.portal-done')).includes(email));

// ---- what actually landed ---------------------------------------------------
const apps = sql(`SELECT id, status FROM applications WHERE cycle_id='${cycleId}'`);
check('one application exists', apps.length, 1);
// 'submitted', not 'draft': the eligibility screen IS a submitted stage-one
// application, and the full application is the stage behind it.
check('and the eligibility stage is recorded as submitted', apps[0].status, 'submitted');
check('a sign-in link was recorded', sql(
  `SELECT COUNT(*) AS n FROM email_messages WHERE to_email='${email}' AND template_key='sign_in_link'`)[0].n, 1);
check('the organization was created once', sql(
  `SELECT COUNT(*) AS n FROM organizations WHERE ein='${ein}'`)[0].n, 1);

// ---- the gate a draft cycle is ----------------------------------------------
sql(`UPDATE cycles SET status='draft' WHERE id='${cycleId}'`);
await page.goto(`${APP}/apply`, { waitUntil: 'networkidle' });
const after = await page.innerText('main');
truthy('a cycle put back into draft disappears from the public page',
  !after.includes(`Front door ${stamp}`));

await page.goto(`${APP}/apply/start/${cycleId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.portal-empty', { timeout: 10_000 });
check('and its start link says so rather than erroring',
  await page.locator('.portal-empty h2').innerText(), 'That program is not open');

check('no console errors', consoleErrors, []);
check('nothing on the page 404s', notFound.filter((u) => !u.includes('/api/public/forms/')), []);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
console.log(
  'Not covered here: email delivery, Turnstile, accessibility, security. ' +
  'Those need their own verification.',
);
process.exit(failures === 0 ? 0 : 1);
