/**
 * The screen where somebody is given access to another organization's grants.
 *
 *   npm run e2e:claims
 *
 * WHY THIS EXISTS. approveClaim is covered by unit tests -- every refusal, the
 * race guard, the audit row. What no unit test can see is the SCREEN: whether
 * the suggestion looks like a suggestion or like an answer, whether the award
 * a reviewer is about to approve against is the one they meant, and whether
 * declining tells them that nobody has been told.
 *
 * That last one matters more than it sounds. Declining sends no email by
 * design, and an admin who assumes otherwise leaves a nonprofit waiting
 * forever for a reply that was never going to come.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. Nothing here says anything
 * about Cloudflare Access, the ADMIN_ONLY guard, or the SQL -- those are the
 * Worker's, and are covered in test/granteeClaims.test.ts. It is also not an
 * accessibility test.
 *
 * PREREQUISITES: `npm run build:web`.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

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

// --- fixtures ---------------------------------------------------------------
// Two claims, shaped as the two cases this screen exists for: one the system
// matched on EIN, and one it could not match at all.
const MATCHED = {
  id: 'claim-matched',
  organizationName: 'Invented Harbor Trust',
  ein: '001234567',
  contactName: 'Alex Moreno',
  contactEmail: 'alex@example-invented.org',
  contactPhone: '713-555-0123',
  contactJobTitle: 'Program Director',
  grantYear: 2024,
  grantDescription: 'After-school reading across two campuses.',
  status: 'pending',
  createdAt: '2026-09-20T14:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
  matchedOrganizationName: 'Invented Harbor Trust',
  matchedAwardId: 'award-harbor-2024',
  matchedAwardLabel: 'Inspire Change — 2024',
  grantedAwardId: null,
};
const UNMATCHED = {
  ...MATCHED,
  id: 'claim-unmatched',
  organizationName: 'Invented Bayou Alliance',
  ein: null,
  contactName: 'Sam Rivera',
  contactEmail: 'sam@example-invented.org',
  matchedOrganizationName: null,
  matchedAwardId: null,
  matchedAwardLabel: null,
};
const DECIDED = {
  ...MATCHED,
  id: 'claim-decided',
  organizationName: 'Invented Reach Collective',
  contactEmail: 'dir@example-invented.org',
  status: 'rejected',
  decidedAt: '2026-09-21T10:00:00.000Z',
  decisionNote: 'No award in our records for this EIN.',
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path.startsWith('/assets/') ? join(root, normalize(path)) : join(root, 'index.html');
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => { res.writeHead(404); res.end('not found'); });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** What the screen sent, so "it used the right award" is observable. */
const calls = { approve: [], reject: [] };
let claims = [MATCHED, UNMATCHED, DECIDED];

async function stubApi(page, { role }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    if (p === '/api/session') return json(route, { user: { id: 'u1', email: 's@example.org', role } });
    if (p === '/api/grantee-claims') return json(route, { claims });
    if (/\/approve$/.test(p)) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      calls.approve.push({ id: p.split('/')[3], ...body });
      claims = claims.map((c) =>
        c.id === p.split('/')[3] ? { ...c, status: 'approved', grantedAwardId: body.awardId } : c);
      return json(route, { claimId: p.split('/')[3], userId: 'u9', awardId: body.awardId, periodsCreated: 1 });
    }
    if (/\/reject$/.test(p)) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      calls.reject.push({ id: p.split('/')[3], ...body });
      claims = claims.map((c) =>
        c.id === p.split('/')[3] ? { ...c, status: 'rejected', decisionNote: body.note } : c);
      return json(route, { claimId: p.split('/')[3] });
    }
    // Everything the shell asks for on the way in.
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    return json(route, {});
  });
}

console.log('Steward — the past-grantee queue, rendered\n');

const { server, port } = await serveAssets('public');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });

// --- an admin ---------------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await stubApi(page, { role: 'admin' });
await page.goto(`${base}/past-grantees`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const body = await page.locator('main').innerText();
check('both waiting claims are listed', /Invented Harbor Trust/.test(body) && /Invented Bayou Alliance/.test(body), true);
check('a decided one is not in the waiting table',
  (await page.locator('table').first().innerText()).includes('Invented Reach Collective'), false);
check('the unmatched claim says so rather than showing nothing',
  /No match on EIN/.test(body), true);

/*
 * THE SUGGESTION IS A BUTTON, NOT A DEFAULT. If the award box arrived
 * pre-filled, a reviewer in a hurry approves whatever an EIN printed on a
 * public tax filing pointed at.
 */
const awardBox = page.locator('#award-claim-matched');
check('the award box starts empty', await awardBox.inputValue(), '');
check('approving with nothing in it refuses, and does not call the API', await (async () => {
  await page.locator('tr', { hasText: 'Invented Harbor Trust' })
    .getByRole('button', { name: 'Connect' }).click();
  await page.waitForTimeout(300);
  return calls.approve.length === 0 && /Put in the award/.test(await page.locator('main').innerText());
})(), true);

await page.getByRole('button', { name: /Use Inspire Change/ }).click();
await page.waitForTimeout(200);
check('the suggestion fills the box when somebody chooses it',
  await awardBox.inputValue(), 'award-harbor-2024');

await page.locator('tr', { hasText: 'Invented Harbor Trust' })
  .getByRole('button', { name: 'Connect' }).click();
await page.waitForTimeout(700);
check('it approved against the award in the box',
  calls.approve.map((c) => c.awardId), ['award-harbor-2024']);
check('and says what happened, including the report period',
  /can now sign in/.test(await page.locator('main').innerText()), true);

// --- declining --------------------------------------------------------------
page.on('dialog', (d) => void d.accept('No award in our records.'));
await page.locator('tr', { hasText: 'Invented Bayou Alliance' })
  .getByRole('button', { name: 'Decline' }).click();
await page.waitForTimeout(700);
check('the reason reaches the API', calls.reject.map((c) => c.note), ['No award in our records.']);
/*
 * THE SENTENCE THAT STOPS A NONPROFIT WAITING FOREVER. Declining is silent by
 * design; an admin who assumes otherwise never sends the message.
 */
check('and the screen says nobody has been told',
  /has not been told/.test(await page.locator('main').innerText()), true);

check('no uncaught errors', errors, []);

// --- a reviewer -------------------------------------------------------------
claims = [MATCHED, UNMATCHED, DECIDED];
const reviewerCtx = await browser.newContext();
const reviewer = await reviewerCtx.newPage();
await stubApi(reviewer, { role: 'reviewer' });
await reviewer.goto(`${base}/past-grantees`, { waitUntil: 'networkidle' });
await reviewer.waitForTimeout(600);
check('a reviewer gets no way to connect anybody',
  await reviewer.getByRole('button', { name: 'Connect' }).count(), 0);

await browser.close();
server.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('Not proven: the API is a fixture. Nothing here tests Cloudflare Access, the');
console.log('ADMIN_ONLY guard or the SQL — those are in test/granteeClaims.test.ts.');
process.exit(failures === 0 ? 0 : 1);
