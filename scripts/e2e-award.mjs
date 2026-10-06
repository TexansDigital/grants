/**
 * The award page, driven in a real browser.
 *
 *   npm run e2e:award
 *
 * WHY THIS EXISTS. Every award screen in this system -- paperwork, payments,
 * amendments -- was mounted inside the application detail view, and imported
 * awards have `application_id = NULL`. So the thirteen 2025 Inspire Change
 * grants had no page: working endpoints, data in the database, and no way for
 * a person to look at any of it. This page is that way, and the state it has
 * to render correctly is the one with NOTHING in it -- no application, no
 * cycle, no project title, and often no report obligations either.
 *
 * A page assembled from eight nullable fields is exactly where a dangling
 * label or an orphan bullet appears, and CLAUDE.md is explicit that blank is
 * the normal state here and must degrade gracefully. That cannot be seen in a
 * unit test. So the checks below render the barest award the system can hold
 * and read what it actually says.
 *
 * The second thing it protects is the blank Reporting section. "No report
 * obligations" is ambiguous between a grant that owes nothing and a grant
 * nobody has asked, and the two have different fixes. The screen must name
 * which one applies and offer that step.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving:
 *   - Nothing about Cloudflare Access or the role guards. The API is a fixture
 *     here; admin-only and the 404-not-403 behaviour are enforced by the
 *     Worker and covered by test/awardPage.test.ts.
 *   - Nothing about the SQL, the amendment, or any write. No database is
 *     touched and every mutation is stubbed.
 *   - It is not an accessibility test.
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
const truthy = (label, value) => {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};
const falsy = (label, value) => {
  const ok = !value;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(value)}`}`);
};

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveAssets(root) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const candidate = join(root, normalize(path));
    const wanted = candidate.startsWith(root) && path !== '/' ? candidate : join(root, 'index.html');
    readFile(wanted)
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(wanted)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() =>
        readFile(join(root, 'index.html')).then(
          (body) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(body);
          },
          () => {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
          },
        ),
      );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const AWARD_ID = 'a1111111-1111-4111-8111-111111111111';

/*
 * The thirteen, as the importer actually writes them: no application, no
 * cycle, no project title, no announcement date, no term dates, and no report
 * obligations. Invented organization name per CLAUDE.md.
 */
const IMPORTED = {
  awardId: AWARD_ID,
  organizationId: 'o1',
  organizationName: 'Bayou Harbor Trust',
  programId: 'p1',
  programName: 'Inspire Change',
  cycleId: null,
  cycleName: null,
  applicationId: null,
  projectTitle: null,
  awardedAmountCents: 3_500_000,
  awardedAt: '2025-10-01T00:00:00.000Z',
  announcementDate: null,
  termStart: null,
  termEnd: null,
  status: 'active',
  isMultiYear: false,
  isPublic: false,
  sourceSystem: 'spreadsheet',
  sourceReference: 'IC-2025-004',
  acceptedAt: null,
  declinedByGranteeAt: null,
  parent: null,
  renewals: [],
  reports: [],
  whyNoReports: 'no_term_dates',
};

const WITH_TERMS = {
  ...IMPORTED,
  termStart: '2025-01-01T00:00:00.000Z',
  termEnd: '2025-12-31T00:00:00.000Z',
  whyNoReports: 'not_requested',
};

const WITH_REPORTS = {
  ...WITH_TERMS,
  whyNoReports: 'has_reports',
  reports: [
    {
      reportPeriodId: 'rp1',
      awardId: AWARD_ID,
      organizationId: 'o1',
      organizationName: 'Bayou Harbor Trust',
      programName: 'Inspire Change',
      label: '2025 progress update',
      periodType: 'final',
      dueDate: '2026-12-03T00:00:00.000Z',
      status: 'open',
      awardedAmountCents: 3_500_000,
      submittedAt: null,
      fundsSpentCents: null,
      daysUntilDue: 58,
      overdue: false,
      reminderCount: 0,
      reminderLastSentAt: null,
    },
  ],
};

/** An award made in Steward, with everything filled in. */
const FULL = {
  ...WITH_REPORTS,
  cycleId: 'c1',
  cycleName: '2026 Spring',
  applicationId: 'app-1',
  projectTitle: 'After-school reading',
  announcementDate: '2026-02-14T00:00:00.000Z',
  sourceSystem: null,
  sourceReference: null,
  isPublic: true,
  isMultiYear: true,
  parent: {
    id: 'a0000000-0000-4000-8000-000000000000',
    awardedAmountCents: 2_500_000,
    awardedAt: '2024-10-01T00:00:00.000Z',
    status: 'closed',
    termStart: null,
    termEnd: null,
  },
  renewals: [],
};

const PAPERWORK = {
  awardId: AWARD_ID,
  organizationName: 'Bayou Harbor Trust',
  status: 'active',
  awardedAmountCents: 3_500_000,
  termStart: null,
  termEnd: null,
  announcementDate: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  acceptedAt: null,
  declinedByGranteeAt: null,
  granteeResponseNote: null,
  documents: [
    { key: 'w9', label: 'W-9', receivedAt: null },
    { key: 'agreement', label: 'Signed grant agreement', receivedAt: null },
    { key: 'media_release', label: 'Media release', receivedAt: null },
  ],
  outstanding: 3,
  scheduledCents: 0,
};

const LEDGER = {
  awardId: AWARD_ID,
  organizationName: 'Bayou Harbor Trust',
  awardedAmountCents: 3_500_000,
  scheduledCents: 0,
  paidCents: 0,
  unscheduledCents: 3_500_000,
  payments: [],
};

const calls = [];

async function stubApi(page, { role, award }) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== 'GET') calls.push(`${method} ${p}`);

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p === `/api/awards/${AWARD_ID}/paperwork`) return json(route, PAPERWORK);
    if (p === `/api/awards/${AWARD_ID}/amendments`) return json(route, { amendments: [] });
    if (p === `/api/awards/${AWARD_ID}/payments`) return json(route, LEDGER);
    if (p === `/api/awards/${AWARD_ID}/report-periods`) return json(route, { created: 1, skipped: [] });
    if (p === `/api/awards/${AWARD_ID}/public`) return json(route, { awardId: AWARD_ID, isPublic: true });
    if (p.startsWith('/api/awards/')) return json(route, award);

    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });
    return json(route, {});
  });
}

async function open(browser, award, opts = {}) {
  const page = await browser.newPage(opts);
  await stubApi(page, { role: 'admin', award });
  await page.goto(`${opts.base}/awards/${AWARD_ID}`);
  await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
    timeout: 10_000,
  });
  return page;
}

async function main() {
  const root = normalize(join(process.cwd(), 'public'));
  const { server, port } = await serveAssets(root);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- 1. the barest grant the system can hold --------------------------
    {
      const errors = [];
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await stubApi(page, { role: 'admin', award: IMPORTED });
      await page.goto(`${base}/awards/${AWARD_ID}`);
      await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
        timeout: 10_000,
      });

      const text = await page.locator('.facts').innerText();
      // The system formats whole dollars without cents, everywhere. This
      // assertion originally demanded "$35,000.00" and the page was right.
      truthy('the amount is shown in dollars', /\$35,000\b/.test(text));
      truthy('and where the grant came from', /spreadsheet/i.test(text) && /IC-2025-004/.test(text));
      /*
       * The point of this check: eight fields are null and the page must not
       * print "null", "undefined", "NaN", or a label with nothing after it.
       */
      /*
       * NaN is matched CASE-SENSITIVELY. With /i it matched "fiNANce" in the
       * payment ledger's own standing note, and reported a fault that was not
       * there -- a test that invents findings is worse than no test.
       */
      falsy(
        'no null, undefined or NaN reaches the screen',
        /\bnull\b|\bundefined\b/i.test(await page.locator('main').innerText()) ||
          /\bNaN\b/.test(await page.locator('main').innerText()),
      );
      /*
       * The explanation's accessible name must be a question a person would
       * ask. InfoTip builds "What does X mean?" from `label`, so a sentence
       * passed there produces "What does Why the grant period matters mean?".
       */
      const tipNames = await page
        .locator('.infotip button')
        .evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      falsy(
        `every explanation reads as something a person would ask (${JSON.stringify(tipNames)})`,
        // A sentence passed as `label` always produces one of these openings.
        tipNames.some((n) => /What does (why|this|these|it|the reason) /i.test(n)),
      );
      truthy(
        'a missing application is explained rather than left blank',
        /no application|None/i.test(text),
      );
      falsy('no console errors on the emptiest award', errors.length > 0);
      await page.close();
    }

    // ---- 2. a blank Reporting section says which blank it is --------------
    {
      const page = await open(browser, IMPORTED, { base });
      const reason = await page.locator('.empty-reason').innerText();
      truthy(
        'without term dates, the screen says generation is impossible',
        /start and end date/i.test(reason),
      );
      truthy('and names the step that fixes it', /Amend/i.test(reason));
      falsy(
        'and does not offer a button that cannot work',
        await page.getByRole('button', { name: 'Create the report obligations' }).count(),
      );
      await page.close();
    }

    {
      const page = await open(browser, WITH_TERMS, { base });
      const reason = await page.locator('.empty-reason').innerText();
      truthy(
        'with term dates, the screen says nobody has asked',
        /never been asked/i.test(reason),
      );
      // And it is explicit that nothing has been emailed, because the single
      // most consequential misreading here is "I pressed it, they were told".
      truthy('and that nothing has been sent', /Nothing has been sent/i.test(reason));

      calls.length = 0;
      await page.getByRole('button', { name: 'Create the report obligations' }).click();
      await page.getByRole('status').first().waitFor({ timeout: 10_000 });
      check(
        'the button writes the obligations',
        calls.filter((c) => c.endsWith('/report-periods')),
        [`POST /api/awards/${AWARD_ID}/report-periods`],
      );
      truthy(
        'and the confirmation repeats that nothing was emailed',
        /nothing has been emailed/i.test(await page.getByRole('status').first().innerText()),
      );
      await page.close();
    }

    // ---- 3. an imported grant is not offered the public toggle ------------
    {
      const page = await open(browser, WITH_REPORTS, { base });
      falsy(
        'no public-listing button on a grant that cannot be published',
        await page.getByRole('button', { name: /public page/i }).count(),
      );
      truthy(
        'and the reason is given',
        /cannot be listed/i.test(await page.locator('.panel').first().innerText()),
      );
      // The obligations render, with their due date and state.
      const reporting = await page.locator('.panel').nth(1).innerText();
      truthy('the obligation is listed', /2025 progress update/.test(reporting));
      truthy('with its due date', /2026-12-03/.test(reporting));
      await page.close();
    }

    // ---- 4. a grant made in Steward shows everything ----------------------
    {
      const page = await open(browser, FULL, { base });
      const text = await page.locator('.facts').innerText();
      truthy('the cycle is named', /2026 Spring/.test(text));
      truthy('and the application is offered as a link', /After-school reading/.test(text));
      truthy(
        'the public listing can be removed',
        await page.getByRole('button', { name: /Remove from the public page/i }).count(),
      );
      truthy(
        'a renewal names the grant it renews',
        /Renews/.test(await page.locator('.panel').nth(2).innerText()),
      );
      await page.close();
    }

    // ---- 5. the amount on the compliance desk reaches the grant ------------
    {
      const page = await browser.newPage();
      await page.route('**/api/**', async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === '/api/session') {
          return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
        }
        if (p === '/api/reports') {
          return json(route, { rows: WITH_REPORTS.reports, total: 1 });
        }
        if (p.startsWith('/api/awards/')) return json(route, WITH_REPORTS);
        if (p === '/api/programs') return json(route, { programs: [] });
        if (p === '/api/cycles') return json(route, { cycles: [] });
        if (p === '/api/forms') return json(route, { forms: [] });
        return json(route, {});
      });
      await page.goto(`${base}/reporting`);
      await page.getByRole('button', { name: /Open the grant for Bayou Harbor Trust/ }).click();
      await page.waitForURL(`${base}/awards/${AWARD_ID}`, { timeout: 10_000 });
      check('the compliance desk reaches the grant', new URL(page.url()).pathname, `/awards/${AWARD_ID}`);
      await page.close();
    }

    // ---- 6. phone width ---------------------------------------------------
    {
      const page = await open(browser, FULL, { base, viewport: { width: 390, height: 780 } });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      await page.screenshot({ path: '/tmp/award-narrow.png', fullPage: true });
      await page.close();
    }

    // Pictures, for a human to look at. Both themes, and the imported case,
    // because that is the one the Foundation will actually see.
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 1000 } });
      const page = await ctx.newPage();
      await stubApi(page, { role: 'admin', award: WITH_REPORTS });
      await page.goto(`${base}/awards/${AWARD_ID}`);
      await page.getByRole('heading', { name: 'Bayou Harbor Trust', exact: true }).waitFor({
        timeout: 10_000,
      });
      await page.screenshot({ path: `/tmp/award-${scheme}.png`, fullPage: true });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
