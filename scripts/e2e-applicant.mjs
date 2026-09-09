/**
 * The applicant path, driven end to end in a real browser against a real local
 * Worker and D1.
 *
 *   npm run e2e:applicant
 *
 * WHY THIS EXISTS AS A CHECKED-IN SCRIPT. Every bug in this path that actually
 * reached a user-visible state was invisible to the unit tests: an autosave
 * engine disposed by a StrictMode remount, a render loop from an unstable hook
 * handle, a submission time formatted in the wrong timezone. The tests were
 * green through all three. A browser is not optional here, and a browser drive
 * that lives in somebody's scratch directory is a browser drive that is run
 * once.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving:
 *   - No email is delivered. Preview has no RESEND_API_KEY, so every message is
 *     recorded and deliberately suppressed. This checks the ROW, not an inbox.
 *   - No file reaches R2. The PUT is intercepted, and its headers inspected,
 *     against a hostname that does not exist. This checks what the browser
 *     SENDS, not what storage accepts.
 *   - It is not a security review and not an accessibility test.
 *
 * PREREQUISITES: `npm run dev` on 8787 and `npm run dev:web` on 5173, and a
 * local database migrated and seeded (see the README section this prints on
 * failure). It writes invented data only, to the local preview database.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';
const WEB = process.env.STEWARD_WEB ?? 'http://127.0.0.1:5173';
const BROWSER = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
};
const note = (label, value) => console.log(`      ${label}: ${value}`);

/** Run one SQL statement against the LOCAL database. Never remote: see CLAUDE.md. */
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

/**
 * Mint a session directly in KV.
 *
 * The alternative is driving the real magic-link flow, which cannot work here:
 * the token is stored hashed and the email that carries it is suppressed, so
 * there is nothing to click. Sign-in has its own tests; this script is about
 * the path AFTER sign-in, and inventing a session is the honest way to reach
 * it. The record shape is the one createSession writes.
 */
/**
 * The SESSIONS namespace id, read from wrangler.toml rather than hardcoded.
 *
 * `wrangler kv key put --binding=SESSIONS --local` silently writes nowhere
 * here; only the explicit `--namespace-id` form lands in the namespace that
 * `wrangler dev` reads. Discovered the hard way, so it is worth the parse.
 */
function sessionsNamespaceId() {
  const toml = readFileSync('wrangler.toml', 'utf8');
  // The first [[kv_namespaces]] block binding SESSIONS is the preview one.
  const block = toml.split('[[kv_namespaces]]').find((b) => /binding\s*=\s*"SESSIONS"/.test(b));
  const id = block && /\bid\s*=\s*"([^"]+)"/.exec(block)?.[1];
  if (!id) throw new Error('could not find the SESSIONS namespace id in wrangler.toml');
  return id;
}

function mintSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const key = `session:${createHash('sha256').update(token).digest('hex')}`;
  const record = {
    userId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
  const file = join(mkdtempSync(join(tmpdir(), 'steward-e2e-')), 'session.json');
  writeFileSync(file, JSON.stringify(record));
  execFileSync(
    'npx',
    ['wrangler', 'kv', 'key', 'put', key, `--path=${file}`,
     `--namespace-id=${sessionsNamespaceId()}`, '--local'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return token;
}

console.log('Steward — applicant path, end to end\n');

// --- fixtures --------------------------------------------------------------
// Invented throughout. EINs begin 00 so they can never collide with a real one;
// addresses are under example-*.org. Never copy a production row in here.
const ids = { org: randomUUID(), user: randomUUID(), cycle: randomUUID(), app: randomUUID() };
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
/*
 * Nine digits, beginning 00, which is not an assignable IRS prefix -- so a
 * fixture EIN can never collide with a real organization's. The database
 * enforces the nine digits with a CHECK, so building this by concatenation and
 * hoping is how the script fails on its first run.
 */
const ein = `00${stamp}0`;
if (ein.length !== 9) throw new Error(`fixture EIN must be nine digits, got ${ein}`);

const formId = one(
  `SELECT fd.id FROM form_definitions fd
    WHERE fd.kind='application' AND fd.status='published'
    ORDER BY fd.version DESC LIMIT 1`, 'id');
const stageId = one(`SELECT stage_id AS id FROM form_definitions WHERE id='${formId}'`, 'id');
const programId = one(`SELECT program_id AS id FROM form_definitions WHERE id='${formId}'`, 'id');

sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${ids.org}','Invented Reach Collective ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.user}','director-${stamp}@example-invented.org','applicant','${ids.org}',1,'${now}','${now}')`);
// A cycle of its own, because an organization may hold one application per
// cycle and re-running this script must not depend on last run's leftovers.
sql(`INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
     VALUES ('${ids.cycle}','${programId}','E2E ${stamp}','2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','open','${now}','${now}')`);
sql(`INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
     VALUES ('${ids.app}','${ids.cycle}','${stageId}','${ids.org}','${formId}','draft','${now}','${now}')`);

const token = mintSession(ids.user);
note('application', ids.app);

// --- the drive -------------------------------------------------------------
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: 'light',
  // Deliberately NOT Central. The submission time an applicant is shown must be
  // the Foundation's timezone, and this is how that gets proven rather than
  // assumed by a machine that happens to be set to it.
  timezoneId: 'Europe/London',
});
await ctx.addCookies([{
  name: '__Host-steward_session', value: token,
  domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
}]);

const puts = [];
await ctx.route('**/*.r2.cloudflarestorage.com/**', async (route) => {
  const r = route.request();
  puts.push({ method: r.method(), headers: r.headers() });
  await route.fulfill({ status: 200, body: '' });
});

const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) consoleErrors.push(m.text().slice(0, 160));
});
const writes = [];
page.on('response', (r) => {
  if (r.request().method() === 'PATCH' && r.url().includes('/draft')) writes.push(r.status());
});

await page.goto(`${WEB}/apply/${ids.app}`, { waitUntil: 'networkidle' });
const go = async (name) => {
  await page.getByRole('button', { name }).first().click();
  await page.waitForTimeout(350);
};

check('the applicant sees no staff preview banner', await page.locator('.banner').count(), 0);

await go(/Eligibility/i);
for (const cb of await page.locator('input[type="checkbox"]').all()) await cb.check();

await go(/Primary contact/i);
await page.fill('input[name="contact_first_name"]', 'Alex');
await page.fill('input[name="contact_last_name"]', 'Moreno');
await page.fill('input[name="contact_email"]', `grants-${stamp}@example-invented.org`);
await page.fill('input[name="contact_phone"]', '713-555-0123');
await page.waitForTimeout(1400);
check('typing produced server writes', writes.every((s) => s === 200) && writes.length > 0, true);
note('draft writes so far', writes.length);

await go(/Organization/i);
await page.fill('input[name="organization_name"]', `Invented Reach Collective ${stamp}`);
// Typed the way an applicant pastes it from a determination letter.
  await page.fill('input[name="ein"]', `${ein.slice(0, 2)}-${ein.slice(2)}`);
const addr = ['address_1', 'address_2', 'city', 'state', 'postal_code', 'country'];
for (const [k, v] of [['address_1', '100 Example Street'], ['city', 'Houston'], ['state', 'TX'], ['postal_code', '77002']]) {
  await page.locator('.address input').nth(addr.indexOf(k)).fill(v);
}
await page.fill('textarea[name="mission_statement"]', 'Expanding after-school literacy programs in under-resourced neighborhoods.');
await page.fill('input[name="annual_operating_budget"]', '825000');

await go(/Your request/i);
await page.fill('input[name="project_title"]', 'Literacy Lab');
await page.fill('input[name="requested_amount"]', '25000');
await page.selectOption('select[name="funding_type"]', { index: 1 }).catch(() => {});
await page.selectOption('select[name="area_of_focus"]', { index: 1 }).catch(() => {});
for (const cb of (await page.locator('input[type="checkbox"][name^="counties_served"]').all()).slice(0, 2)) await cb.check();
await page.fill('textarea[name="itemized_budget"]', 'Tutors $12,000. Materials $5,000. Evaluation $8,000.').catch(() => {});

await go(/Narrative/i);
for (const ta of await page.locator('textarea').all()) {
  await ta.fill('Reading intervention paired with mentoring for four hundred students each year across two campuses.');
}
for (const n of await page.locator('input[inputmode="numeric"], input[type="number"]').all()) await n.fill('400');

await go(/Documents/i);
for (const input of await page.locator('input[type="file"]').all()) {
  await input.setInputFiles({ name: 'budget.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(50_000, 1) });
  await page.waitForTimeout(600);
}
check('every required document attached',
  (await page.locator('.upload-name').allInnerTexts()).length,
  await page.locator('input[type="file"]').count());

// THE RULE: signQuery signs only the host header, so a Content-Type from the
// browser is a 403 that does not reproduce in curl.
check('the browser sent no content-type on any upload',
  puts.map((p) => p.headers['content-type'] ?? null).filter(Boolean), []);
check('every upload was a PUT', [...new Set(puts.map((p) => p.method))], ['PUT']);

await go(/Staying in touch/i);
for (const cb of await page.locator('input[type="checkbox"]').all()) await cb.check();
await page.waitForTimeout(1200);

await go(/Review and submit/i);
await page.waitForTimeout(500);
check('nothing outstanding on the review screen', await page.locator('.summary li').count(), 0);

await page.getByRole('button', { name: /Submit application/ }).click();
await page.waitForTimeout(3000);
check('the applicant is told it is in', await page.locator('main h2').first().innerText(), 'Your application is in');
const submittedLine = (await page.locator('.section-head p').first().innerText()).split('.')[0];
note('confirmation code', await page.locator('.confirmation .code').innerText());
note('submitted line', submittedLine);
check('the time carries the Foundation timezone, not the browser one',
  /\b(CST|CDT)\b/.test(submittedLine), true);

const second = await ctx.newPage();
await second.goto(`${WEB}/apply/${ids.app}`, { waitUntil: 'networkidle' });
await second.waitForTimeout(400);
check('a submitted application offers nothing to edit',
  await second.locator('input:not([type=hidden])').count(), 0);

check('no uncaught errors in the browser', consoleErrors, []);
await browser.close();

// --- what actually landed --------------------------------------------------
console.log('\n  On the server:');
const app = sql(`SELECT status, requested_amount_cents, ein_at_submit, primary_contact_email
                   FROM applications WHERE id='${ids.app}'`)[0];
check('status', app.status, 'submitted');
check('money is integer cents', app.requested_amount_cents, 2_500_000);
check('the EIN was promoted', typeof app.ein_at_submit === 'string' && app.ein_at_submit.length === 9, true);
check('the contact email was promoted', app.primary_contact_email, `grants-${stamp}@example-invented.org`);

check('attachments claimed onto the application',
  one(`SELECT COUNT(*) AS n FROM attachments WHERE parent_id='${ids.app}'`, 'n') > 0, true);
check('a submit audit row exists',
  one(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id='${ids.app}' AND action='application.submitted'`, 'n'), 1);
check('the confirmation email was recorded',
  one(`SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key='application_received:${ids.app}'`, 'n'), 1);
check('the narrative is searchable',
  one(`SELECT COUNT(*) AS n FROM application_fts WHERE application_fts MATCH 'literacy'
        AND application_id='${ids.app}'`, 'n'), 1);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('Not proven here: no email was delivered, no file reached R2, and');
console.log('this is neither a security review nor an accessibility test.');
process.exit(failures === 0 ? 0 : 1);
