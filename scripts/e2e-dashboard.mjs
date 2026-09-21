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
  return {
    status, awards: [], awardId: null, payments: [], documents: [],
    amendments: [], amended: [],
    amountCents: 2_500_029, updatedAt: '2026-11-01T12:00:00.000Z',
  };
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
    if (p === '/api/awards/w1/amendments') {
      return json(route, { amendments: s.amendments });
    }
    if (p === '/api/awards/w1' && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      s.amended.push(body);
      s.amendments.push({
        id: `am${s.amendments.length + 1}`, awardId: 'w1',
        amendedAt: '2026-11-20T12:00:00.000Z', amendedBy: 'admin@example.org',
        fieldChanged: 'awarded_amount_cents',
        oldValue: '2500029', newValue: String(body.awardedAmountCents),
        reason: body.reason,
      });
      s.amountCents = body.awardedAmountCents;
      s.updatedAt = '2026-11-20T12:00:00.000Z';
      return json(route, { awardId: 'w1', changed: ['awarded_amount_cents'], updatedAt: s.updatedAt });
    }
    if (p === '/api/awards/w1/paperwork') {
      return json(route, {
        awardId: 'w1', organizationName: 'Invented Collective', status: 'pending',
        awardedAmountCents: s.amountCents, termStart: null, termEnd: null,
        announcementDate: null, updatedAt: s.updatedAt,
        acceptedAt: null, declinedByGranteeAt: null, granteeResponseNote: null,
        documents: [
          { key: 'w9', label: 'W-9', receivedAt: null },
          { key: 'agreement', label: 'Signed grant agreement', receivedAt: null },
          { key: 'media_release', label: 'Media release', receivedAt: null },
        ],
        outstanding: 3,
        scheduledCents: s.payments.reduce((t, x) => t + x.amountCents, 0),
      });
    }
    if (p === '/api/awards/w1/document' && method === 'POST') {
      s.documents.push(JSON.parse(route.request().postData() ?? '{}'));
      return json(route, { awardId: 'w1', document: 'w9', receivedAt: null });
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

    // ---- what it looks like printed, which is the executives' PDF ---------
    /*
     * CLAUDE.md: "Executives never log in, so the export is the product for
     * them and must stand alone", and asks for a PDF for board and league
     * reporting. There is no PDF generator here -- carrying a rendering
     * library into a Worker for a document produced a handful of times a year
     * is not a trade worth making -- so the browser's print-to-PDF IS the PDF,
     * and the print stylesheet is the whole of its design.
     *
     * Until it existed, printing this page produced a dark-themed screenshot
     * with a navigation bar, a theme toggle and a "Download the summary"
     * button across the top of a board paper, and every table clipped at the
     * first screenful because its scroll container printed as-is.
     */
    await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    const printed = await page.evaluate(() => {
      const rgb = (el) => getComputedStyle(el).backgroundColor;
      const scroll = document.querySelector('.table-scroll');
      const head = document.querySelector('thead th');
      return {
        bodyBackground: rgb(document.body),
        navShown: [...document.querySelectorAll('.mainnav, .theme-toggle')]
          .some((el) => getComputedStyle(el).display !== 'none'),
        buttonsShown: [...document.querySelectorAll('.btn')]
          .some((el) => getComputedStyle(el).display !== 'none'),
        tableOverflow: scroll ? getComputedStyle(scroll).overflowX : null,
        headerRepeats: document.querySelector('thead')
          ? getComputedStyle(document.querySelector('thead')).display
          : null,
        stickyHeader: head ? getComputedStyle(head).position : null,
        stillHasFigures: document.body.innerText.includes('$63,500'),
      };
    });

    check('a printed page is white, whatever theme the viewer had',
      printed.bodyBackground, 'rgb(255, 255, 255)');
    check('the navigation and the theme toggle are gone', printed.navShown, false);
    check('and so is every button, because a printed button is a lie',
      printed.buttonsShown, false);
    check('the table is not clipped at the first screenful',
      printed.tableOverflow, 'visible');
    check('the column headings repeat on every page',
      printed.headerRepeats, 'table-header-group');
    check('and they are not sticky, which prints as an overlap',
      printed.stickyHeader, 'static');
    check('the figures are still there', printed.stillHasFigures, true);

    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

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

    // ---- the paperwork, which had columns and no screen -------------------
    /*
     * The three document columns have been on `awards` since 0012 and nothing
     * could write them; the data health screen has been checking active
     * awards for a missing W-9 against columns no page could fill.
     */
    await page.getByRole('heading', { name: 'Before funds are released' }).waitFor();
    // `.last()`, because the paperwork panel is nested inside the decision
    // panel -- so the outer one matches the filter too.
    const paperwork = await page
      .locator('.panel', { has: page.getByRole('heading', { name: 'Before funds are released' }) })
      .last()
      .innerText();
    check('all three documents are listed', [
      paperwork.includes('W-9'),
      paperwork.includes('Signed grant agreement'),
      paperwork.includes('Media release'),
    ], [true, true, true]);
    check(
      'and it says the grantee has not accepted yet, so none of it is due from them',
      paperwork.includes('has not accepted this award yet'),
      true,
    );

    /*
     * THE DATE IS NOT HARD-CODED TO TODAY. The payment ledger learned this
     * the hard way: a receipt field fixed to today is permanently wrong for
     * anything recorded late, on the column that answers "when did we have
     * it".
     */
    await page.getByRole('button', { name: /Record receipt/ }).first().click();
    await page.locator('#document-date').waitFor();
    await page.locator('#document-date').fill('2026-10-14');
    await page.getByRole('button', { name: 'Record it' }).click();
    await page.getByText('recorded as received').waitFor();
    check('one document call went out', s.documents.length, 1);
    check('it named the W-9', s.documents[0].document, 'w9');
    check(
      'and carried the date that was typed, not today',
      s.documents[0].receivedAt.slice(0, 10),
      '2026-10-14',
    );

    // ---- amending it, which was impossible ---------------------------------
    /*
     * 0012 has refused to let an awarded amount be updated since Phase 0,
     * pointing at an amendments table Phase 4 never built -- so an award
     * recorded at the wrong amount could not be corrected through this system
     * at all.
     */
    await page.getByRole('heading', { name: 'Amendments' }).waitFor();
    check(
      'an unamended award says so rather than showing an empty table',
      (await page.locator('body').innerText()).includes('unchanged since it was recorded'),
      true,
    );
    await page.getByRole('button', { name: 'Amend this award' }).click();
    await page.locator('#amend-reason').waitFor();
    check(
      'the form opens on the current amount, so nothing reads as a change',
      await page.locator('#amend-amount').inputValue(),
      '25000.29',
    );
    check(
      'and it will not fire while nothing has changed',
      await page.getByRole('button', { name: 'Record this amendment' }).isDisabled(),
      true,
    );

    await page.locator('#amend-amount').fill('18,000');
    await page.locator('#amend-reason').fill('The partner site withdrew.');
    await page.getByRole('button', { name: 'Record this amendment' }).click();
    await page.getByText('Amended: Amount').waitFor();

    check('one amendment went out', s.amended.length, 1);
    check('dollars became integer cents', s.amended[0].awardedAmountCents, 1_800_000);
    check('it carried the reason', s.amended[0].reason, 'The partner site withdrew.');
    check(
      'and the concurrency token the screen had loaded',
      s.amended[0].expectedUpdatedAt,
      '2026-11-01T12:00:00.000Z',
    );
    const amendBody = await page.locator('body').innerText();
    check('the history shows the change in money, not in cents', [
      amendBody.includes('$25,000.29'),
      amendBody.includes('$18,000'),
      amendBody.includes('The partner site withdrew.'),
    ], [true, true, true]);

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
