/**
 * The award offer on the grantee portal, driven in a real browser.
 *
 *   npm run e2e:offer
 *
 * WHY SEPARATELY FROM e2e-grantee. That harness drives a real local Worker and
 * D1 and needs `npm run dev` and a seeded database; this one stubs the API and
 * runs anywhere, which is what makes it cheap enough to run on every change.
 * The two answer different questions and both are worth having.
 *
 * WHAT THIS PROVES. The offer renders above the reports; the embargo date is
 * repeated on the page a grantee comes back to; Accept is refused until the
 * attestation is ticked; the exact attestation text is sent to the server
 * rather than a boolean; refusing is a real button and needs a reason; and
 * answering re-reads the portal, because accepting generates the reporting
 * schedule the section below it shows.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. Organization scoping — another
 * organization's award is a 404 — is enforced server-side and covered in
 * test/acceptance.test.ts.
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
      (ok
        ? ''
        : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path.startsWith('/assets/') ? join(root, normalize(path)) : join(root, 'index.html');
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const OFFER = {
  id: 'w1',
  programName: 'Inspire Change',
  awardedAmountCents: 2_500_000,
  awardedAt: '2026-04-01T12:00:00.000Z',
  announcementDate: '2026-11-05T12:00:00.000Z',
  termStart: '2026-05-01T12:00:00.000Z',
  termEnd: '2027-04-30T12:00:00.000Z',
  projectTitle: 'After-school meals in Fort Bend',
};

function state() {
  return { answered: false, accepts: [], declines: [] };
}

async function stubApi(page, s) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (p === '/api/grantee/home') {
      return json(route, {
        organization: { name: 'Invented Chorus' },
        awards: s.answered
          ? [
              {
                id: 'w1', program: 'Inspire Change', amountCents: 2_500_000,
                awardedAt: OFFER.awardedAt, termStart: OFFER.termStart, termEnd: OFFER.termEnd,
                status: 'active',
                reports: [
                  {
                    id: 'rp1', label: 'Final report', periodType: 'final',
                    dueDate: '2027-05-30T12:00:00.000Z', state: 'not_open_yet',
                    outstanding: false, formDefinitionId: null,
                    periodStart: null, periodEnd: null, opensAt: null,
                    submittedAt: null, adminFeedback: null,
                  },
                ],
              },
            ]
          : [],
      });
    }
    if (p === '/api/my/awards') {
      return json(route, { awards: s.answered ? [] : [OFFER] });
    }
    if (p === '/api/my/awards/w1/accept' && method === 'POST') {
      s.accepts.push(JSON.parse(route.request().postData() ?? '{}'));
      s.answered = true;
      return json(route, { awardId: 'w1', acceptedAt: new Date().toISOString(), reportPeriodsCreated: 1 });
    }
    if (p === '/api/my/awards/w1/decline' && method === 'POST') {
      s.declines.push(JSON.parse(route.request().postData() ?? '{}'));
      s.answered = true;
      return json(route, { awardId: 'w1', declinedAt: new Date().toISOString() });
    }
    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- accepting --------------------------------------------------------
    const s = state();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubApi(page, s);

    await page.goto(`${base}/reports`);
    await page.getByRole('heading', { name: /waiting for your answer/ }).waitFor();

    const body = await page.locator('body').innerText();
    check(
      'the page rendered rather than falling into the error boundary',
      body.includes('Something went wrong'),
      false,
    );
    check('the amount and programme are shown', body.includes('$25,000'), true);
    /*
     * THE EMBARGO, REPEATED HERE. The letter is read once on a phone; this is
     * the page somebody comes back to, and "when can we post about it" is the
     * question they come back with.
     */
    check('the embargo date is repeated on the page', body.includes('hold the news until'), true);

    /*
     * ACCEPT IS REFUSED UNTIL THE ATTESTATION IS TICKED. A button with no
     * statement beside it produces an acceptance nobody can characterise later.
     */
    check(
      'Accept is refused until the statement is ticked',
      await page.getByRole('button', { name: 'Accept this grant' }).isDisabled(),
      true,
    );
    await page.locator('#attest-w1').check();
    check(
      'and allowed once it is',
      await page.getByRole('button', { name: 'Accept this grant' }).isDisabled(),
      false,
    );

    await page.getByRole('button', { name: 'Accept this grant' }).click();
    // Wait for the offer to go, not for a heading whose wording depends on
    // whether a report is outstanding yet -- it is not, on a term that starts
    // next month.
    await page.waitForFunction(
      () => !document.body.innerText.includes('waiting for your answer'),
    );

    /*
     * THE WORDS, NOT A BOOLEAN. The attestation text goes to the server and
     * lands on the audit row, so "what did they agree to" survives a later
     * edit to the copy on this page.
     */
    check('the attestation text was sent, not a flag', typeof s.accepts[0].attestationText, 'string');
    check(
      'and it is the sentence the grantee saw',
      s.accepts[0].attestationText.includes('authorised to accept this grant'),
      true,
    );
    check(
      'the offer is gone once answered',
      await page.getByRole('button', { name: 'Accept this grant' }).count(),
      0,
    );
    /*
     * ACCEPTING GENERATES THE REPORTING SCHEDULE, so the portal is re-read
     * rather than the offer merely being hidden -- the section below it was
     * empty a moment ago and is not any more.
     */
    check(
      'and the reporting schedule that acceptance created is now shown',
      (await page.locator('body').innerText()).includes('Final report'),
      true,
    );
    await ctx.close();

    // ---- refusing ---------------------------------------------------------
    const s2 = state();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, s2);
    await page2.goto(`${base}/reports`);
    await page2.getByRole('heading', { name: /waiting for your answer/ }).waitFor();

    /*
     * SAYING NO IS A REAL BUTTON, not a link to an email address. Making it
     * hard does not make it happen less; it makes it happen silently, and the
     * award sits pending forever with the committed total wrong.
     */
    await page2.getByRole('button', { name: 'We cannot accept' }).click();
    await page2.locator('#decline-w1').waitFor();
    check(
      'a refusal cannot be sent empty',
      await page2.getByRole('button', { name: 'Send this' }).isDisabled(),
      true,
    );
    await page2.locator('#decline-w1').fill('We lost the matching funder.');
    await page2.getByRole('button', { name: 'Send this' }).click();
    await page2.waitForFunction(
      () => !document.body.innerText.includes('waiting for your answer'),
    );
    check('the reason travelled with it', s2.declines[0].reason, 'We lost the matching funder.');
    await ctx2.close();

    // ---- nothing offered --------------------------------------------------
    const s3 = state();
    s3.answered = true;
    const ctx3 = await browser.newContext();
    const page3 = await ctx3.newPage();
    await stubApi(page3, s3);
    await page3.goto(`${base}/reports`);
    await page3.getByRole('heading', { name: 'Invented Chorus' }).waitFor();
    check(
      'a grantee with nothing to answer sees no offer section',
      await page3.getByRole('heading', { name: /waiting for your answer/ }).count(),
      0,
    );
    await ctx3.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
