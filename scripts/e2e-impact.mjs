/**
 * The Impact screen, driven in a real browser.
 *
 *   npm run e2e:impact
 *
 * WHY THIS HARNESS IS MOSTLY ABOUT WORDS. Every other screen in this system
 * fails by being hard to use. This one fails by being believed. A figure here
 * goes into a board paper, a league report or a press line, and once it has
 * been copied out of this page nobody can see the denominator behind it. So
 * the checks below are overwhelmingly about what the screen SAYS:
 *
 *   1. The coverage sentence is present, and above the numbers rather than
 *      below them -- a note underneath is a footnote, and footnotes do not
 *      travel with a copied figure.
 *   2. A metric nobody has answered reads "Not reported yet" and NEVER "0".
 *   3. A grantee who genuinely reached nobody reads "0", not "not reported".
 *   4. A written answer produces no figure at all.
 *   5. A programme where nothing has been asked says so, rather than
 *      presenting "0 of 0 updates" as though the year were complete.
 *
 * WHAT IT DOES NOT PROVE: nothing about Cloudflare Access, the ADMIN_ONLY
 * guard, or the SQL. The API is a fixture; those live in test/impact.test.ts.
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

/* Three grantees of thirteen have filed. The shape the Foundation will see. */
const PARTIAL = {
  generatedAt: '2026-10-06T12:00:00.000Z',
  year: null,
  years: [2025, 2024],
  programs: [
    {
      programId: 'p1',
      programName: 'Inspire Change',
      obligations: 13,
      accepted: 3,
      grantsNeverAsked: 0,
      grants: 13,
      totalAwardedCents: 46_900_000,
      metrics: [
        {
          metricDefinitionId: 'm1',
          label: 'Individuals served',
          metricType: 'integer',
          unit: 'people',
          total: 4200,
          answered: 3,
        },
        {
          metricDefinitionId: 'm2',
          label: 'Volunteer hours',
          metricType: 'integer',
          unit: 'hours',
          total: null,
          answered: 0,
        },
        {
          metricDefinitionId: 'm3',
          label: 'Participants reached in rural counties',
          metricType: 'integer',
          unit: 'people',
          total: 0,
          answered: 1,
        },
        {
          metricDefinitionId: 'm4',
          label: 'Populations served',
          metricType: 'text',
          unit: null,
          total: null,
          answered: 3,
        },
        {
          metricDefinitionId: 'm5',
          label: 'Funds spent',
          metricType: 'currency',
          unit: null,
          total: 12_000_000,
          answered: 3,
        },
      ],
    },
  ],
};

/* The state the thirteen are in today: funded, nothing asked. */
const NOTHING_ASKED = {
  ...PARTIAL,
  years: [],
  programs: [
    {
      ...PARTIAL.programs[0],
      obligations: 0,
      accepted: 0,
      grantsNeverAsked: 13,
      totalAwardedCents: 0,
      metrics: PARTIAL.programs[0].metrics.map((m) => ({ ...m, total: null, answered: 0 })),
    },
  ],
};

async function stubApi(page, payload) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
    }
    if (p === '/api/impact') {
      const year = url.searchParams.get('year');
      return json(route, year === null ? payload : { ...payload, year: Number(year) });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });
    return json(route, {});
  });
}

async function main() {
  const root = normalize(join(process.cwd(), 'public'));
  const { server, port } = await serveAssets(root);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- a partly-reported year -------------------------------------------
    {
      const errors = [];
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await stubApi(page, PARTIAL);
      await page.goto(`${base}/impact`);
      await page.locator('.coverage').waitFor({ timeout: 10_000 });

      const cov = await page.locator('.coverage').innerText();
      truthy('the coverage names how many updates it rests on', /3 of 13 updates accepted/i.test(cov));
      truthy('and the money behind them', /\$469,000/.test(cov));

      /*
       * ABOVE the numbers. Compared by position on the page, because "it is
       * in the markup somewhere" is exactly the version that fails: a reader
       * copying 4,200 into a slide must have had to scroll past this.
       */
      const covY = await page.locator('.coverage').evaluate((el) => el.getBoundingClientRect().top);
      const numY = await page
        .locator('.impact-number')
        .first()
        .evaluate((el) => el.getBoundingClientRect().top);
      truthy(`the coverage sits above the first figure (${covY} < ${numY})`, covY < numY);

      const body = await page.locator('main').innerText();
      truthy('an answered metric shows its figure', /4,200 people/.test(body));
      truthy('with the number of updates behind it', /from 3 updates/.test(body));
      truthy('currency is formatted as money', /\$120,000/.test(body));

      /*
       * THE THREE ABSENCES, each different. These are the assertions this
       * screen exists for.
       */
      const unanswered = page.locator('div', { has: page.getByText('Volunteer hours', { exact: true }) }).last();
      truthy(
        'a metric nobody answered reads as not reported',
        /Not reported yet/i.test(await unanswered.innerText()),
      );
      falsy(
        'and never as a zero',
        /\b0 hours\b/.test(await unanswered.innerText()),
      );

      const genuineZero = page
        .locator('div', { has: page.getByText('Participants reached in rural counties', { exact: true }) })
        .last();
      truthy(
        'a grantee who genuinely reached nobody shows zero',
        /\b0 people\b/.test(await genuineZero.innerText()),
      );
      falsy(
        'and is not erased as unreported',
        /Not reported yet/i.test(await genuineZero.innerText()),
      );

      const written = page
        .locator('div', { has: page.getByText('Populations served', { exact: true }) })
        .last();
      truthy(
        'a written answer says who answered',
        /3 grantees answered/i.test(await written.innerText()),
      );
      falsy(
        'and produces no figure of its own',
        /\b\d+\s*(people|hours)\b/.test(await written.innerText()),
      );

      falsy(
        'no null, undefined or NaN reaches the screen',
        /\bnull\b|\bundefined\b/i.test(body) || /\bNaN\b/.test(body),
      );
      falsy('no console errors', errors.length > 0);

      // The year lives in the address, so a year's impact is a link.
      await page.locator('#impact-year').selectOption('2025');
      await page.waitForFunction(
        () => /Grant year 2025/.test(document.querySelector('.panel-head .meta')?.textContent ?? ''),
        undefined,
        { timeout: 10_000 },
      );
      check('the year is in the address', new URL(page.url()).searchParams.get('year'), '2025');
      await page.close();
    }

    // ---- a programme where nothing has been asked --------------------------
    {
      const page = await browser.newPage();
      await stubApi(page, NOTHING_ASKED);
      await page.goto(`${base}/impact`);
      await page.locator('.coverage').waitFor({ timeout: 10_000 });

      const cov = await page.locator('.coverage').innerText();
      /*
       * THE STATE THE THIRTEEN ARE IN TODAY. "0 of 0 updates accepted" would
       * read as a complete year rather than an empty one, which is how an
       * untouched programme gets reported as a finished one.
       */
      truthy('it says nothing has been reported', /Nothing below has been reported/i.test(cov));
      truthy('and that none of the grants has been asked', /13 grants in this programme has|13 grants/.test(cov));
      falsy('and never presents it as complete', /0 of 0/.test(cov));
      await page.close();
    }

    // ---- a nonsense year in the address ------------------------------------
    {
      const page = await browser.newPage();
      await stubApi(page, PARTIAL);
      await page.goto(`${base}/impact?year=banana`);
      await page.locator('.coverage').waitFor({ timeout: 10_000 });
      /*
       * A query string anybody can edit must not become NaN, which would ask
       * for an impossible year and render an empty page that reads as "we
       * achieved nothing".
       */
      check(
        'an unreadable year falls back to every year',
        await page.locator('.panel-head .meta').first().innerText(),
        'Every year',
      );
      await page.close();
    }

    // ---- phone width -------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      await stubApi(page, PARTIAL);
      await page.goto(`${base}/impact`);
      await page.locator('.coverage').waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      await page.close();
    }

    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1280, height: 900 },
      });
      const page = await ctx.newPage();
      await stubApi(page, PARTIAL);
      await page.goto(`${base}/impact`);
      await page.locator('.coverage').waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `/tmp/impact-${scheme}.png`, fullPage: true });
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
