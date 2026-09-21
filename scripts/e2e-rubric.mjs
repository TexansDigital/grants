/**
 * The rubric builder and the retention screen, driven in a real browser.
 *
 *   npm run e2e:rubric
 *
 * WHY THIS EXISTS. Four faults reached a live deployment on this project and
 * none was visible to a green test suite -- Access scoped to the Worker, the
 * asset router answering "/", a sign-in page that was never built, a CSP that
 * made every upload impossible. All four were found by opening the page. The
 * unit tests here are good and prove nothing about whether the screen renders.
 *
 * WHAT THIS PROVES. The built bundle renders both screens; the weight field
 * takes a decimal and the arithmetic that turns it into basis points is right
 * where it is visible, including the total; publishing disables the inputs and
 * swaps the action; field errors from the API are shown; and the retention
 * screen distinguishes a file that has been asked for from one that has not.
 *
 * WHAT IT DOES NOT PROVE, and must not be reported as proving. The API is a
 * fixture. Nothing here touches Cloudflare Access, the role guards, the SQL,
 * R2, or the cron. It is not an accessibility test: it checks that controls
 * have names, not how a screen reader announces them.
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

// ---------------------------------------------------------------------------
// Fixtures. Invented program, invented organization, invented EIN.
// ---------------------------------------------------------------------------

const PROGRAM = {
  id: 'p1',
  name: 'Inspire Change',
  slug: 'inspire-change',
  status: 'active',
  fiscal_year: 2026,
  compliance_policy: 'warn',
};

/** 10*30000 + 10*20000 + 5*10000 = 550000 score-basis-points, i.e. 55 points. */
const CRITERIA = [
  {
    id: 'c1', criterion_key: 'community_need', label: 'Critical community need',
    description: null, weight_bp: 30000, max_score: 10, sort_order: 0,
  },
  {
    id: 'c2', criterion_key: 'measurable_outcomes', label: 'Measurable outcomes',
    description: null, weight_bp: 20000, max_score: 10, sort_order: 1,
  },
  {
    id: 'c3', criterion_key: 'organizational_capacity', label: 'Capacity to deliver',
    description: null, weight_bp: 10000, max_score: 5, sort_order: 2,
  },
];

function rubricState() {
  return {
    status: 'draft',
    saved: [],
    rejectNext: false,
  };
}

async function stubApi(page, state) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'admin@example.org', role: 'admin' } });
    }
    if (p === '/api/programs') return json(route, { programs: [PROGRAM] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });

    if (p === '/api/programs/p1/rubrics' && method === 'GET') {
      return json(route, {
        rubrics: [
          {
            id: 'r1', program_id: 'p1', name: 'Inspire Change scoring',
            rubric_key: 'inspire_change', version: 1, status: state.status,
            max_total_score: state.status === 'published' ? 550000 : null,
            published_at: null,
          },
        ],
      });
    }
    if (p === '/api/rubrics/r1' && method === 'GET') {
      return json(route, {
        rubric: {
          id: 'r1', program_id: 'p1', name: 'Inspire Change scoring',
          rubric_key: 'inspire_change', version: 1, status: state.status,
          max_total_score: state.status === 'published' ? 550000 : null,
          published_at: null,
        },
        criteria: CRITERIA,
        maxTotalScoreBp: 550000,
        cyclesUsing: [],
      });
    }
    if (p === '/api/rubrics/r1/criteria' && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      state.saved.push(body.criteria);
      if (state.rejectNext) {
        state.rejectNext = false;
        return json(
          route,
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'This rubric is not ready to save yet.',
              fields: [{ field: 'criteria[3].label', message: 'Every criterion needs a label.' }],
            },
          },
          422,
        );
      }
      const bp = body.criteria.reduce((t, c) => t + c.maxScore * c.weightBp, 0);
      return json(route, { rubricId: 'r1', criteria: body.criteria.length, maxTotalScoreBp: bp });
    }
    if (p === '/api/rubrics/r1/publish' && method === 'POST') {
      state.status = 'published';
      return json(route, {
        rubricId: 'r1', version: 1, maxTotalScoreBp: 550000, retiredRubricId: null,
      });
    }

    if (p === '/api/retention' && method === 'GET') {
      return json(route, {
        upcoming: [
          {
            id: 'a1', filename: 'audited-2025.pdf', organization_name: 'Invented Trust',
            project_title: null, application_id: 'app1',
            effective_due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
            download_url_first_issued_at: null,
          },
          {
            id: 'a2', filename: 'operating-budget.xlsx', organization_name: 'Invented Alliance',
            project_title: null, application_id: 'app2',
            effective_due_at: new Date(Date.now() + 21 * 86400000).toISOString(),
            download_url_first_issued_at: new Date().toISOString(),
          },
        ],
        purged: [
          {
            id: 'a0', filename: 'old-statements.pdf', organization_name: 'Invented Fund',
            purged_at: '2026-06-01T07:00:00.000Z', application_id: 'app0',
          },
        ],
      });
    }

    return json(route, {});
  });
}

async function main() {
  const { server, port } = await serveAssets(join(process.cwd(), 'public'));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    const state = rubricState();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Two of the three actions on these screens go through window.confirm or
    // window.prompt. Answering them here is what lets the flow be driven at
    // all; the fact that they exist is the point -- publishing and deleting
    // both need a deliberate second act.
    page.on('dialog', (d) => d.accept('Board query open'));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('   console:', m.text());
    });
    page.on('pageerror', (e) => console.log('   pageerror:', e.message));
    await stubApi(page, state);

    // ---- the builder ------------------------------------------------------
    await page.goto(`${base}/programs/p1/rubrics`);
    await page.getByRole('heading', { name: 'Scoring rubrics' }).waitFor();

    await page.getByRole('button', { name: /^Open Inspire Change scoring/ }).click();
    await page.getByRole('heading', { name: /version 1 \(draft\)/ }).waitFor();

    /*
     * THE ARITHMETIC, WHERE A PERSON SEES IT. Nobody thinks in basis points,
     * so the field reads 3 and the wire carries 30000. A criterion out of 10
     * at weight 3 counts for 30; the rubric is scored out of 55. If this
     * number is wrong on screen, a rubric gets built to the wrong shape and
     * nobody finds out until a ranking.
     */
    const weights = await page.locator('input[id^="crit-weight-"]').evaluateAll((els) =>
      els.map((e) => e.value),
    );
    check('weights render as decimals, not basis points', weights, ['3', '2', '1']);

    const total = await page.locator('tfoot .num strong').innerText();
    check('the rubric totals 55 points', total, '55');

    // Change one weight and watch the total follow before any save.
    await page.locator('#crit-weight-2').fill('2');
    check(
      'the total follows a weight change immediately',
      await page.locator('tfoot .num strong').innerText(),
      '60',
    );
    await page.locator('#crit-weight-2').fill('1');

    // ---- a decimal weight -------------------------------------------------
    /*
     * 0.15 is not representable in binary floating point -- it is
     * 0.1499999999999999944... -- so truncating would store 1499 basis points
     * for a weight somebody typed as 0.15. Rounding is what makes the field
     * mean what it says.
     */
    await page.locator('#crit-weight-2').fill('0.15');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Saved.').waitFor();
    const lastSave = state.saved[state.saved.length - 1];
    check(
      'a decimal weight is rounded to whole basis points, not truncated',
      lastSave[2].weightBp,
      1500,
    );
    check(
      'and the keys the criteria already had are carried, not regenerated',
      lastSave.map((c) => c.criterionKey),
      ['community_need', 'measurable_outcomes', 'organizational_capacity'],
    );

    // ---- validation errors come back to the field -------------------------
    state.rejectNext = true;
    await page.getByRole('button', { name: 'Add criterion' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Every criterion needs a label.').waitFor();
    check(
      'a field error from the API is shown, not swallowed',
      await page.getByText('Every criterion needs a label.').count(),
      1,
    );

    // ---- publishing freezes it --------------------------------------------
    await page.reload();
    await page.getByRole('button', { name: /^Open Inspire Change scoring/ }).click();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('heading', { name: /version 1 \(published\)/ }).waitFor();

    check(
      'every weight field is disabled once published',
      await page.locator('input[id^="crit-weight-"]:not([disabled])').count(),
      0,
    );
    check(
      'there is no way to save a published rubric',
      await page.getByRole('button', { name: 'Save draft' }).count(),
      0,
    );
    check(
      'and the way forward is offered instead',
      await page.getByRole('button', { name: 'New version from this' }).count(),
      1,
    );

    // ---- the retention screen ---------------------------------------------
    await page.goto(`${base}/retention`);
    await page.getByRole('heading', { name: 'Retention' }).waitFor();

    /*
     * "Asked for", never "downloaded". Downloads go from the browser straight
     * to R2, so this system knows a link was issued and cannot know the bytes
     * arrived. The person reading this column is deciding whether it is safe
     * to let another organization's audited accounts be destroyed.
     */
    // Table headers are uppercased by the stylesheet, so compare in one case.
    // Asserting on the markup instead would stop testing what a person reads.
    const header = (await page.locator('thead th').allInnerTexts()).map((t) => t.toLowerCase());
    check('the column says what it can actually know', header.includes('asked for'), true);
    check('and never claims a download happened', header.includes('downloaded'), false);

    const firstRowAsked = await page.locator('tbody tr').first().locator('td').nth(2).innerText();
    check('a file nobody has asked for reads No', firstRowAsked, 'No');

    check(
      'what was already destroyed is still listed',
      await page.getByText('old-statements.pdf').count(),
      1,
    );

    await ctx.close();

    // ---- a reviewer is offered none of it ---------------------------------
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await stubApi(page2, rubricState());
    await page2.route('**/api/session', (route) =>
      json(route, { user: { id: 'u2', email: 'reviewer@example.org', role: 'reviewer' } }),
    );
    await page2.goto(`${base}/configuration`);
    await page2.getByRole('heading', { name: 'Inspire Change' }).first().waitFor();
    check(
      'a reviewer is not offered the rubric builder',
      await page2.getByRole('button', { name: /^Scoring rubrics/ }).count(),
      0,
    );
    check(
      'nor a retention door that would answer FORBIDDEN',
      await page2.getByRole('button', { name: 'Retention' }).count(),
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
