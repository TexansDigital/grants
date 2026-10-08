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

import { watchRenderErrors } from './lib/renderErrors.mjs';
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
  grantedOrganizationName: null,
  grantedAwardLabel: null,
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
/*
 * A claim that WAS connected, and connected to an award filed under a
 * different name than the claimant typed. That mismatch is the normal case --
 * "Harbor Trust" writing in about an award to "Invented Harbor Trust, Inc." --
 * and it is the only reason the Decided list needs to say what access went to.
 */
const CONNECTED = {
  ...MATCHED,
  id: 'claim-connected',
  organizationName: 'Harbor Trust',
  contactEmail: 'ops@example-invented.org',
  status: 'approved',
  decidedAt: '2026-09-22T10:00:00.000Z',
  decisionNote: null,
  grantedAwardId: 'award-harbor-2024',
  grantedOrganizationName: 'Invented Harbor Trust',
  grantedAwardLabel: 'Inspire Change 2024 · $25,000',
};

/*
 * Two awards for one organization, on purpose. The picker has to make them
 * distinguishable -- a reviewer choosing between "Inspire Change 2023" and
 * "Inspire Change 2024" for the same nonprofit is the realistic case, and a
 * list that shows only the organization name makes that choice a coin toss.
 */
const AWARDS = [
  {
    id: 'award-harbor-2024',
    organizationName: 'Invented Harbor Trust',
    ein: '001234567',
    programName: 'Inspire Change',
    awardedAmountCents: 2_500_000,
    awardedYear: '2024',
    status: 'active',
    alreadyHeldBy: null,
  },
  {
    id: 'award-harbor-2023',
    organizationName: 'Invented Harbor Trust',
    ein: '001234567',
    programName: 'Inspire Change',
    awardedAmountCents: 1_500_000,
    awardedYear: '2023',
    status: 'active',
    alreadyHeldBy: 'someone@example-invented.org',
  },
];

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
let claims = [MATCHED, UNMATCHED, DECIDED, CONNECTED];

async function stubApi(page, { role }) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    if (p === '/api/session') return json(route, { user: { id: 'u1', email: 's@example.org', role } });
    if (p === '/api/grantee-claims') return json(route, { claims });
    if (p === '/api/awards/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json(route, {
        awards: AWARDS.filter(
          (a) =>
            a.organizationName.toLowerCase().includes(q) ||
            (a.ein ?? '').replace(/\D/g, '') === q.replace(/\D/g, ''),
        ),
      });
    }
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

// A render error becomes a named failure rather than a locator timeout.
watchRenderErrors(browser, (m) => check(m, false, true));
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
check('a decided one is not in the waiting queue',
  (await page.locator('[data-claim]').allInnerTexts()).join(' ')
    .includes('Invented Reach Collective'), false);
/*
 * THE EIN RESULT, IN WORDS A PROGRAM MANAGER CAN ACT ON. This used to read
 * "No match on EIN", which states the outcome of a process the reader never
 * saw, does not say whether it is bad, and does not say what to do next.
 */
check('an unmatched claim explains the result and what to do instead',
  /nothing matched/i.test(body) && /Search for the award yourself/i.test(body), true);
/*
 * A DISABLED CONTROL WITH NO REASON READS AS BROKEN. The first real user hit
 * exactly this and asked why the buttons were greyed out.
 */
check('the greyed-out Connect says why it is greyed out',
  /Choose an award above/i.test(body), true);

/*
 * THE SUGGESTION IS A BUTTON, NOT A DEFAULT. If the award box arrived
 * pre-filled, a reviewer in a hurry approves whatever an EIN printed on a
 * public tax filing pointed at.
 */
const row = page.locator('[data-claim]', { hasText: 'Invented Harbor Trust' });
check('Connect is disabled until an award is chosen',
  await row.getByRole('button', { name: 'Connect' }).isDisabled(), true);

await row.getByRole('button', { name: 'Find the award' }).click();
await page.waitForTimeout(800);
/*
 * SEEDED WITH WHAT THE CLAIM SAYS, so the commonest case is one click from
 * done -- but still a click on a NAMED award, never a pre-filled id.
 */
check('the search starts from the EIN on the claim',
  await page.locator('#find-claim-matched').inputValue(), '001234567');
/*
 * The box is seeded with what the CLAIMANT wrote, which reads as "this is
 * what is being searched for" -- and usually is not what the award is filed
 * under. The first real user searched the claimant's wording, got nothing,
 * and concluded the screen was broken.
 */
check('and says what it actually searches',
  /on the award/i.test(await row.innerText()), true);

const options = page.locator('#find-claim-matched ~ button');
check('both of that organization awards are offered', await options.count(), 2);
const optionText = await options.allInnerTexts();
check('and they are told apart by year and amount',
  optionText.some((t) => /2024/.test(t) && /25,000/.test(t)) &&
    optionText.some((t) => /2023/.test(t) && /15,000/.test(t)), true);

await options.first().click();
await page.waitForTimeout(300);
check('choosing one shows what was chosen, in words',
  /Inspire Change 2024/.test(await row.innerText()), true);

await row.getByRole('button', { name: 'Connect' }).click();
await page.waitForTimeout(700);
check('it approved against the award in the box',
  calls.approve.map((c) => c.awardId), ['award-harbor-2024']);
check('and says what happened, including the report period',
  /can now sign in/.test(await page.locator('main').innerText()), true);

/*
 * THE WARNING THAT MATTERS. An award somebody already holds is not
 * necessarily the wrong one -- two people from one nonprofit both reporting
 * is ordinary -- but it is always worth seeing before approving, and it is
 * invisible from the claim itself.
 */
await page.locator('[data-claim]', { hasText: 'Invented Bayou Alliance' })
  .getByRole('button', { name: 'Find the award' }).click();
await page.fill('#find-claim-unmatched', 'Invented Harbor Trust');
await page.waitForTimeout(800);
const held = await page.locator('#find-claim-unmatched ~ button').nth(1).innerText();
check('an award somebody already holds is offered, and flagged once chosen', await (async () => {
  await page.locator('#find-claim-unmatched ~ button').nth(1).click();
  await page.waitForTimeout(300);
  return /already has access/.test(
    await page.locator('[data-claim]', { hasText: 'Invented Bayou Alliance' }).innerText(),
  );
})(), true);
void held;



/*
 * A FAILED SEARCH IS NOT AN EMPTY SEARCH.
 *
 * The catch set an empty result, which rendered "Nothing matches. If this
 * grant predates the system, it has to be imported before anyone can be
 * connected to it." -- a confident, specific and WRONG diagnosis for a server
 * error, sending an admin off to import a grant that already exists. This is
 * the only route by which a past grantee reaches their own award.
 */
/*
 * Fresh page: an award was chosen above, which replaces the picker's opening
 * button, and this check is about the picker rather than about that claim.
 */
await page.reload();
await page.locator('[data-claim]').first().waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: 'Find the award' }).first().click();
const finder = page.locator("input[id^='find-']").first();
await finder.waitFor({ timeout: 10_000 });

await page.route('**/api/awards/search**', (route) =>
  route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL', message: 'nope' } }),
  }),
);
await finder.fill('Invented Harbor Trust');
await page.waitForTimeout(900);
const failedText = await page.locator('[data-claim]').first().innerText();
check('a search that errored says so', /could not be run/.test(failedText), true);
check(
  'and does not claim the grant is missing',
  /Nothing matches/.test(failedText),
  false,
);

// --- declining --------------------------------------------------------------
page.on('dialog', (d) => void d.accept('No award in our records.'));
await page.locator('[data-claim]', { hasText: 'Invented Bayou Alliance' })
  .getByRole('button', { name: 'Decline' }).click();
await page.waitForTimeout(700);
check('the reason reaches the API', calls.reject.map((c) => c.note), ['No award in our records.']);
/*
 * THE SENTENCE THAT STOPS A NONPROFIT WAITING FOREVER. Declining is silent by
 * design; an admin who assumes otherwise never sends the message.
 */
check('and the screen says nobody has been told',
  /has not been told/.test(await page.locator('main').innerText()), true);

/*
 * WHO DID WE LET IN. The Decided list showed the organization name the
 * CLAIMANT typed, which is right for the record and no use for an audit: the
 * two differ exactly when somebody should be looking.
 */
const connectedRow = await page.locator('tr', { hasText: 'Harbor Trust' }).last().innerText();
check('a connected claim names the award the access went to',
  /Invented Harbor Trust/.test(connectedRow) && /Inspire Change 2024/.test(connectedRow), true);
check('and a declined one says plainly that nothing was granted',
  /Nothing — no access was given/.test(
    await page.locator('tr', { hasText: 'Invented Reach Collective' }).innerText()), true);

check('no uncaught errors', errors, []);

// --- a reviewer -------------------------------------------------------------
claims = [MATCHED, UNMATCHED, DECIDED, CONNECTED];
const reviewerCtx = await browser.newContext();
const reviewer = await reviewerCtx.newPage();
await stubApi(reviewer, { role: 'reviewer' });
await reviewer.goto(`${base}/past-grantees`, { waitUntil: 'networkidle' });
await reviewer.waitForTimeout(600);
/*
 * EXACT, and it has to be. Playwright matches an accessible name by SUBSTRING
 * by default, and the panel carries an InfoTip whose name is "What does
 * connecting somebody mean?" -- which contains "connect". Without exact, this
 * check counted an explanation as a way to grant access and failed on a build
 * where the guard was perfectly intact. A test that reports a fault it
 * invented is worse than no test.
 */
check('a reviewer gets no way to connect anybody',
  await reviewer.getByRole('button', { name: 'Connect', exact: true }).count(), 0);
check('nor to decline, nor to go looking for an award',
  [
    await reviewer.getByRole('button', { name: 'Decline', exact: true }).count(),
    await reviewer.getByRole('button', { name: 'Find the award', exact: true }).count(),
  ], [0, 0]);
/*
 * But they DO see the queue. Hiding it entirely would tell a reviewer the
 * screen was broken; what they must not have is the act.
 */
check('but still sees the claims themselves',
  await reviewer.locator('[data-claim]').count(), 2);

await browser.close();
server.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
console.log('Not proven: the API is a fixture. Nothing here tests Cloudflare Access, the');
console.log('ADMIN_ONLY guard or the SQL — those are in test/granteeClaims.test.ts.');
process.exit(failures === 0 ? 0 : 1);
