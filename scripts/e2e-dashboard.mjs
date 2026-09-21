/**
 * The dashboard and the award record, driven in a real browser.
 *
 *   npm run e2e:dashboard
 *
 * WHY. Every fault on this project that reached a running deployment was found
 * by opening the page, and five of them were a new route missing from the list
 * that loads session data, so the screen hung on "Loading..." forever.
 *
 * WHAT THIS PROVES. The dashboard renders; the caveats that make the numbers
 * honest are ON the screen and not only in the file; the export is a real link
 * the browser will save; the over-budget flag appears; the award form takes
 * dollars and sends CENTS, rounded rather than truncated; and it only appears
 * on an application that was actually awarded.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. The aggregation rules --
 * cancelled awards excluded, drafts not counted, only accepted reports
 * totalled -- are enforced server-side and covered in test/dashboard.test.ts.
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

const DASHBOARD = {
  generatedAt: '2026-09-21T12:00:00.000Z',
  awardTotals: [
    {
      fiscalYear: 2026, programId: 'p1', programName: 'Inspire Change',
      cycleId: 'cy1', cycleName: '2026 cycle', awards: 3,
      committedCents: 6_350_000, smallestCents: 100_000, largestCents: 6_000_000,
    },
  ],
  funnel: [
    {
      programId: 'p1', programName: 'Inspire Change', cycleId: 'cy1',
      cycleName: '2026 cycle', closesAt: '2026-03-01T05:59:00.000Z',
      received: 63, underReview: 0, awarded: 17, declined: 46, withdrawn: 0,
      successRateBp: 2698,
    },
  ],
  compliance: [
    {
      programId: 'p1', programName: 'Inspire Change', scheduled: 2, open: 4,
      submitted: 1, revisionsRequested: 0, accepted: 9, waived: 1, overdue: 3,
      total: 17, complianceRateBp: 5882,
    },
  ],
  metrics: [
    {
      programId: 'p1', programName: 'Inspire Change', metricDefinitionId: 'm1',
      label: 'People served', metricType: 'integer', unit: 'people',
      reports: 6, total: 4200,
    },
    {
      programId: 'p1', programName: 'Inspire Change', metricDefinitionId: 'm2',
      label: 'Populations served', metricType: 'text', unit: null,
      reports: 6, total: null,
    },
  ],
  disbursement: [
    {
      programId: 'p1', programName: 'Inspire Change', fiscalYear: 2026,
      committedCents: 6_350_000, scheduledCents: 4_000_000, paidCents: 2_500_000,
    },
  ],
  budget: [
    {
      programId: 'p1', programName: 'Inspire Change', fiscalYear: 2026,
      totalBudgetCents: 5_000_000, committedCents: 6_350_000, awards: 3, overBudget: true,
    },
  ],
  // Empty now that the payment ledger exists. The field stays, because an
  // export that can state its own gaps is worth more than one that has none
  // today and quietly grows some later.
  notAvailable: [],
};

function appState(status) {
  return { status, awards: [], awardId: null, payments: [] };
}

async function stubApi(page, s) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'admin@example.org', role: 'admin' } });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/dashboard') return json(route, DASHBOARD);

    if (p === '/api/applications/app1') {
      return json(route, {
        application: {
          id: 'app1', organization_id: 'o1', status: s.status,
          project_title: 'After-school meals', requested_amount_cents: 2_500_000,
          submitted_at: '2026-02-01T12:00:00.000Z',
          decided_at: '2026-04-01T12:00:00.000Z', form_definition_id: null,
        },
        organization: { id: 'o1', legal_name: 'Invented Collective' },
        answers: {},
        attachments: [],
        award: s.awardId ? { id: s.awardId, status: 'pending' } : null,
      });
    }
    if (p === '/api/organizations/o1/history') {
      return json(route, {
        organization: { id: 'o1', legal_name: 'Invented Collective' },
        applications: [],
        summary: { total_applications: 0, by_status: {} },
      });
    }
    if (p === '/api/applications/app1/scores') {
      return json(route, {
        applicationId: 'app1', rubric: null, reviewers: [], meanCompletedBp: null,
        byCriterion: [],
      });
    }
    if (p === '/api/awards/w1/payments' && method === 'GET') {
      return json(route, {
        awardId: 'w1', organizationName: 'Invented Collective',
        awardedAmountCents: 2_500_029,
        scheduledCents: s.payments.reduce((t, x) => t + x.amountCents, 0),
        paidCents: 0,
        unscheduledCents:
          2_500_029 - s.payments.reduce((t, x) => t + x.amountCents, 0),
        payments: s.payments,
      });
    }
    if (p === '/api/awards/w1/payments' && method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      s.payments.push({
        id: `pay${s.payments.length + 1}`, awardId: 'w1',
        amountCents: body.amountCents, scheduledDate: body.scheduledDate,
        paidDate: null, status: 'scheduled', method: null,
        referenceNumber: null, note: null,
      });
      return json(route, s.payments[s.payments.length - 1], 201);
    }
    if (p === '/api/applications/app1/award' && method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      s.awards.push(body);
      s.awardId = 'w1';
      return json(route, {
        awardId: 'w1', applicationId: 'app1',
        awardedAmountCents: body.awardedAmountCents, status: 'pending',
      }, 201);
    }
    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- the dashboard ----------------------------------------------------
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubApi(page, appState('awarded'));

    await page.goto(`${base}/dashboard`);
    /*
     * WAIT FOR CONTENT, NOT FOR THE TITLE. The loading branch renders the same
     * heading, so waiting on it and then counting "Loading…" was a race --
     * and it lost, intermittently. Waiting for a section that only exists once
     * the data has arrived is deterministic.
     */
    await page.getByRole('heading', { name: 'Against budget' }).waitFor();
    check(
      'the page rendered rather than hanging on Loading',
      await page.getByText('Loading…').count(),
      0,
    );

    const body = await page.locator('body').innerText();
    /*
     * PROVE THE PAGE RENDERED BEFORE ASSERTING WHAT IS ON IT. An over-budget
     * row once threw inside formatCents -- negative cents -- and the error
     * boundary replaced the whole page, which several of the checks below
     * would have reported as "the text is missing" rather than "the page is
     * gone".
     */
    check(
      'the page rendered rather than falling into the error boundary',
      body.includes('Something went wrong on this page'),
      false,
    );

    /*
     * THE CAVEATS ARE ON THE SCREEN, not only in the downloaded file. An admin
     * who does not know disbursement is missing will be asked for it in the
     * meeting, and "total awarded" is not one number -- it is a number plus a
     * rule about cancelled and pending grants.
     */
    /*
     * COMMITTED, SCHEDULED AND PAID, all three. The dashboard used to announce
     * that it could not answer the second half of "committed versus
     * disbursed"; the payment ledger closed that, and these are the numbers
     * that replaced the apology.
     */
    check(
      'committed, scheduled and paid are all shown',
      [
        body.includes('$63,500'),
        body.includes('$40,000'),
        body.includes('$25,000'),
      ],
      [true, true, true],
    );
    check(
      'and the screen says Steward does not move money',
      body.includes('It does not move money'),
      true,
    );
    check(
      'and carries the exclusion rules beside the numbers',
      [
        body.includes('Cancelled awards are excluded'),
        body.includes('Drafts that were never submitted are not counted'),
        body.includes('Overdue means past its due date'),
        body.includes('Only accepted reports are counted'),
      ],
      [true, true, true, true],
    );

    check(
      'money reads as dollars, from cents',
      body.includes('$63,500'),
      true,
    );
    /*
     * 17 of 63 is 26.98%. Held as basis points and divided once at the edge,
     * so a column of these still sums -- the same discipline money follows.
     */
    check('the funded rate keeps its decimal', body.includes('27.0%'), true);
    check(
      'a written answer shows no total rather than a zero',
      await page.locator('tbody tr').filter({ hasText: 'Populations served' }).locator('td').last().innerText(),
      '—',
    );
    check(
      'the denominator sits beside the total',
      await page.locator('tbody tr').filter({ hasText: 'People served' }).locator('td').nth(1).innerText(),
      '6',
    );

    // The badge is uppercased by the stylesheet, so compare in one case.
    // Asserting on the markup instead would stop testing what a person reads.
    check(
      'a program over its budget is flagged',
      body.toLowerCase().includes('over budget'),
      true,
    );
    // And says by how much, rather than printing a negative remaining figure
    // that a board has to translate.
    check('and says by how much', body.includes('over by $13,500'), true);
    check(
      'the export is a real link the browser will save',
      await page.getByRole('link', { name: 'Download the summary' }).getAttribute('href'),
      '/api/dashboard.csv',
    );

    // ---- the award record -------------------------------------------------
    const s = appState('awarded');
    await page.unroute('**/api/**');
    await stubApi(page, s);
    await page.goto(`${base}/applications/app1`);
    await page.getByRole('heading', { name: 'Award record' }).waitFor();

    /*
     * DOLLARS IN, CENTS ON THE WIRE, rounded rather than truncated. 25000.29
     * in binary floating point is 25000.289999..., and truncating would record
     * an award one cent short of what somebody typed.
     */
    await page.locator('#award-amount').fill('$25,000.29');
    await page.locator('#award-announce').fill('2026-11-05');
    await page.getByRole('button', { name: 'Record the award' }).click();
    await page.getByText('pending acceptance').waitFor();

    check('dollars became integer cents', s.awards[0].awardedAmountCents, 2500029);
    check(
      'and the embargo date travelled with it',
      s.awards[0].announcementDate.slice(0, 10),
      '2026-11-05',
    );
    check(
      'the screen says the award is pending, not accepted',
      (await page.locator('body').innerText()).includes('pending acceptance'),
      true,
    );

    // ---- the payment ledger, once an award exists -------------------------
    /*
     * STEWARD DOES NOT PAY ANYBODY, and the screen has to say so. A button
     * reading "Pay" would be a lie about what this system does; what an admin
     * is doing is writing down somebody else's fact.
     */
    await page.locator('#payment-amount').waitFor();
    check(
      'the ledger says Steward does not move money',
      (await page.locator('body').innerText()).includes('It does not move money'),
      true,
    );
    await page.locator('#payment-amount').fill('8,333.33');
    await page.locator('#payment-due').fill('2026-12-01');
    await page.getByRole('button', { name: 'Schedule a payment' }).click();
    await page.getByText('Record as paid').waitFor();
    check('dollars became integer cents', s.payments[0].amountCents, 833333);
    check(
      'the action is "Record as paid", not "Pay"',
      await page.getByRole('button', { name: /^Pay$/ }).count(),
      0,
    );
    await ctx.close();

    // ---- a declined application gets no award form ------------------------
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, appState('declined'));
    await page2.goto(`${base}/applications/app1`);
    await page2.getByRole('heading', { name: 'Reviews' }).waitFor();
    check(
      'a declined application is offered no award form',
      await page2.getByRole('heading', { name: 'Award record' }).count(),
      0,
    );
    await ctx2.close();
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
