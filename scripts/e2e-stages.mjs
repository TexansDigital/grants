/**
 * The two-stage path, driven end to end: eligibility, then the full
 * application, then a file.
 *
 *   npm run e2e:stages
 *
 * WHY THIS EXISTS. Inspire Change files two applications for one grant
 * request. The first is a ten-question eligibility screen; the second is the
 * thirty-four-question form with the uploads on it. Every part of that worked
 * and the join between them did not: nothing in the UI called
 * POST /api/applications, so an applicant who passed eligibility had no route
 * to the form they were waiting to fill in. The portal told them "We have it.
 * You do not need to do anything else for now."
 *
 * Both halves of that sentence were wrong, and no test in this repository
 * could see it, because each half was correct on its own. This drives the
 * JOIN.
 *
 * PREREQUISITES: `npm run build:web`, then `npm run dev`, against a local
 * database migrated and seeded. Invented data only.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.STEWARD_WORKER ?? 'http://127.0.0.1:8787';
const BROWSER =
  process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PERSIST = process.env.STEWARD_PERSIST ?? null;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};
const note = (label, value) => console.log(`      ${label}: ${value}`);

const scope = () => ['--local', ...(PERSIST ? [`--persist-to=${PERSIST}`] : [])];
function sql(statement) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'steward-preview', ...scope(), '--json', '--command', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
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
  const file = join(mkdtempSync(join(tmpdir(), 'steward-stages-')), 'session.json');
  writeFileSync(file, JSON.stringify({
    userId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }));
  execFileSync(
    'npx',
    ['wrangler', 'kv', 'key', 'put', key, `--path=${file}`,
     `--namespace-id=${sessionsNamespaceId()}`, ...scope()],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return token;
}

console.log('Steward — eligibility, then the application, then a file\n');

// --- fixtures ---------------------------------------------------------------
const now = new Date().toISOString();
const stamp = Date.now().toString().slice(-6);
const ein = `00${stamp}0`;
const ids = { org: randomUUID(), user: randomUUID(), cycle: randomUUID(), app1: randomUUID() };

const programId = one(
  `SELECT ps.program_id AS id FROM program_stages ps
     JOIN form_definitions fd ON fd.stage_id=ps.id AND fd.status='published'
    GROUP BY ps.program_id HAVING COUNT(*) >= 2 LIMIT 1`, 'id');
const stages = sql(
  `SELECT ps.id, ps.stage_key, ps.sort_order, fd.id AS form_id
     FROM program_stages ps
     JOIN form_definitions fd ON fd.stage_id=ps.id AND fd.status='published'
    WHERE ps.program_id='${programId}' ORDER BY ps.sort_order`);
check('the program has two published stages', stages.length, 2);
note('stages', stages.map((s) => `${s.sort_order}:${s.stage_key}`).join(', '));

sql(`INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES ('${ids.org}','Invented Step Trust ${stamp}','${ein}','active','${now}','${now}')`);
sql(`INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES ('${ids.user}','steps-${stamp}@example-invented.org','applicant','${ids.org}',1,'${now}','${now}')`);
sql(`INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
     VALUES ('${ids.cycle}','${programId}','Stages ${stamp}','2020-01-01T00:00:00.000Z',
             '2099-01-01T00:00:00.000Z','open','${now}','${now}')`);
// Stage one already submitted: exactly what the eligibility screen leaves behind.
sql(`INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
       status, submitted_at, created_at, updated_at)
     VALUES ('${ids.app1}','${ids.cycle}','${stages[0].id}','${ids.org}','${stages[0].form_id}',
             'submitted','${now}','${now}','${now}')`);

const token = mintSession(ids.user);
note('organization', ids.org);

// --- drive ------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{
  name: '__Host-steward_session', value: token,
  domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax',
}]);
const puts = [];
await ctx.route(
  (url) => url.hostname.endsWith('.r2.cloudflarestorage.com'),
  async (route) => {
    puts.push({ method: route.request().method(), headers: route.request().headers() });
    await route.fulfill({ status: 200, body: '' });
  },
);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${APP}/reports`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

/*
 * THE SENTENCE THAT SENT PEOPLE AWAY. It has to be gone, not merely joined by
 * something better: an applicant who reads "you do not need to do anything
 * else" stops reading.
 */
const body = await page.locator('main').innerText();
check('the portal no longer says there is nothing left to do',
  /do not need to do anything else/i.test(body), false);
check('and it names the step that is outstanding',
  /full application/i.test(body), true);

const go = page.getByRole('button', { name: /Continue your application/i });
check('there is a button that starts it', await go.count(), 1);
await go.click();
await page.waitForTimeout(2500);

check('which lands on an application, not back at the eligibility screen',
  /^\/apply\/[0-9a-f-]{36}$/.test(new URL(page.url()).pathname), true);
const startedId = new URL(page.url()).pathname.split('/').pop();
check('a NEW application, at the second stage',
  one(`SELECT stage_id AS id FROM applications WHERE id='${startedId}'`, 'id'),
  stages[1].id);
check('owned by this organization',
  one(`SELECT organization_id AS id FROM applications WHERE id='${startedId}'`, 'id'), ids.org);
check('and a draft, so it can be filled in',
  one(`SELECT status FROM applications WHERE id='${startedId}'`, 'status'), 'draft');
check('an audit row records it being created',
  one(`SELECT COUNT(*) AS n FROM audit_log
        WHERE entity_id='${startedId}' AND action='application.created'`, 'n'), 1);

/*
 * AND THE UPLOADS ARE REAL. This is the whole point: the previous behaviour
 * put an applicant in front of a form whose upload fields were disabled,
 * because there was no application to attach a file to.
 */
const sections = page.locator('nav button, .section-nav button');
for (let i = 0; i < (await sections.count()); i += 1) {
  const name = (await sections.nth(i).innerText()).replace(/\s+/g, ' ');
  if (!/document/i.test(name)) continue;
  await sections.nth(i).click();
  await page.waitForTimeout(400);
}
check('the documents section offers real file inputs',
  (await page.locator('input[type=file]').count()) > 0, true);
check('and no preview notice anywhere on it',
  await page.locator('text=not available in this preview').count(), 0);

const fileInput = page.locator('input[type=file]').first();
await fileInput.setInputFiles({
  name: 'budget.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20_000, 1),
});
await page.waitForTimeout(1500);
check('a file uploads', puts.filter((p) => p.method === 'PUT').length > 0, true);
// The rule R2 punishes with a 403 that does not reproduce in curl.
check('with no content-type from the browser',
  puts.filter((p) => p.method === 'PUT').map((p) => p.headers['content-type'] ?? null).filter(Boolean),
  []);
check('and it is recorded against this organization',
  one(`SELECT COUNT(*) AS n FROM attachments WHERE organization_id='${ids.org}'`, 'n') > 0, true);

check('no uncaught errors', errors, []);

// --- starting it twice ------------------------------------------------------
const second = await ctx.newPage();
await second.goto(`${APP}/reports`, { waitUntil: 'networkidle' });
await second.waitForTimeout(600);
check('the portal stops offering to start it once it is started',
  await second.getByRole('button', { name: /Continue your application/i }).count(), 0);
check('and offers to carry on with the draft instead',
  await second.getByRole('button', { name: /Carry on/i }).count() > 0, true);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('Not proven here: no file reached R2 -- the PUT is intercepted against a');
console.log('hostname that does not exist. This checks what the browser SENDS.');
process.exit(failures === 0 ? 0 : 1);
