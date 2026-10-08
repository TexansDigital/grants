/**
 * The Grants and Organizations lists, driven in a real browser.
 *
 *   npm run e2e:lists
 *
 * WHY THESE SCREENS EXIST. Awards could be reached only through the
 * application that produced them, or one at a time by id -- so "show me the
 * grants" had no answer. And "which of our grantees cannot be reached by
 * anything this system sends" could only be asked one nonprofit at a time,
 * which is useless for finding the ones nobody has thought about.
 *
 * So the checks below are, in order of what they protect:
 *   1. A list that is filtered says so, and never reports a filtered count as
 *      the whole count.
 *   2. "Nothing asked yet" is distinguished from "all in" -- the first is the
 *      Foundation's omission and the second is a clean record, and a dash
 *      would read as the second.
 *   3. The never-signed-in filter actually narrows, and its empty state reads as
 *      good news rather than as a broken screen.
 *   4. Filter state is in the URL, so a filtered list is a link.
 *   5. Both lists reach their detail pages.
 *
 * WHAT IT DOES NOT PROVE: nothing about Cloudflare Access, the ADMIN_ONLY
 * guards or the SQL. The API is a fixture; those live in test/awardPage.test.ts
 * and test/organizationPage.test.ts.
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

/* Invented names and invented EINs, per CLAUDE.md. */
const AWARDS = [
  {
    id: 'aw-1',
    organizationId: 'org-1',
    organizationName: 'Bayou Harbor Trust',
    programName: 'Inspire Change',
    awardedAmountCents: 3_500_000,
    awardedAt: '2025-10-01T00:00:00.000Z',
    status: 'active',
    termStart: null,
    termEnd: null,
    reportsTotal: 0,
    reportsOverdue: 0,
    reportsOutstanding: 0,
    granteeLastSignInAt: null,
  },
  {
    id: 'aw-2',
    organizationId: 'org-2',
    organizationName: 'Third Ward Futures',
    programName: 'Inspire Change',
    awardedAmountCents: 2_500_000,
    awardedAt: '2025-09-01T00:00:00.000Z',
    status: 'active',
    termStart: '2025-01-01T00:00:00.000Z',
    termEnd: '2025-12-31T00:00:00.000Z',
    reportsTotal: 1,
    reportsOverdue: 1,
    reportsOutstanding: 1,
    granteeLastSignInAt: '2026-09-28T00:00:00.000Z',
  },
  {
    id: 'aw-3',
    organizationId: 'org-3',
    organizationName: 'Harrisburg Arts Collective',
    programName: 'Inspire Change',
    awardedAmountCents: 1_000_000,
    awardedAt: '2024-10-01T00:00:00.000Z',
    status: 'completed',
    termStart: null,
    termEnd: null,
    reportsTotal: 2,
    reportsOverdue: 0,
    reportsOutstanding: 0,
    granteeLastSignInAt: '2026-08-01T00:00:00.000Z',
  },
];

const ORGS = [
  {
    id: 'org-1',
    legalName: 'Bayou Harbor Trust',
    ein: '871234567',
    einVerifiedAt: null,
    status: 'active',
    grants: 1,
    totalAwardedCents: 3_500_000,
    lastAwardedAt: '2025-10-01T00:00:00.000Z',
    applications: 0,
    reportsOverdue: 0,
    hasAccount: true,
    lastSignInAt: null,
  },
  {
    id: 'org-2',
    legalName: 'Third Ward Futures',
    ein: '872345678',
    einVerifiedAt: '2025-11-01T00:00:00.000Z',
    status: 'active',
    grants: 1,
    totalAwardedCents: 2_500_000,
    lastAwardedAt: '2025-09-01T00:00:00.000Z',
    applications: 2,
    reportsOverdue: 1,
    hasAccount: true,
    lastSignInAt: '2026-09-28T00:00:00.000Z',
  },
  {
    id: 'org-4',
    legalName: 'Never Funded Society',
    ein: null,
    einVerifiedAt: null,
    status: 'active',
    grants: 0,
    totalAwardedCents: 0,
    lastAwardedAt: null,
    applications: 1,
    reportsOverdue: 0,
    hasAccount: false,
    lastSignInAt: null,
  },
];

async function stubApi(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
    }
    if (p === '/api/awards') {
      /*
       * The stub applies the SAME after-the-page filtering the module does,
       * so the screen's count line is exercised against a filtered set that
       * is genuinely smaller than `total`.
       */
      const rows =
        url.searchParams.get('outstanding') === 'true'
          ? AWARDS.filter((a) => a.reportsOutstanding > 0)
          : AWARDS;
      return json(route, { rows, total: AWARDS.length });
    }
    if (p === '/api/organizations') {
      const rows =
        url.searchParams.get('never_signed_in') === 'true'
          ? ORGS.filter((o) => o.grants > 0 && o.lastSignInAt === null)
          : ORGS;
      return json(route, { rows, total: ORGS.length });
    }
    if (p === '/api/programs') {
      return json(route, { programs: [{ id: 'p1', name: 'Inspire Change', status: 'active' }] });
    }
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

  // A render error becomes a named failure rather than a locator timeout.
  watchRenderErrors(browser, (m) => check(m, false, true));
  try {
    // ---- the grants list --------------------------------------------------
    {
      const errors = [];
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await stubApi(page);
      await page.goto(`${base}/awards`);
      await page.locator('tbody tr').first().waitFor({ timeout: 10_000 });

      check('every grant is listed', await page.locator('tbody tr').count(), AWARDS.length);

      /*
       * THE FILTER LABELS SIT ABOVE THEIR CONTROLS, not jammed against them.
       *
       * These screens first used a bare <label> wrapping the text and the
       * control, which matches no rule in the stylesheet -- so every caption
       * ran into its dropdown ("Still owing a report[No]"). The house pattern
       * is a .filter wrapper with a real <label htmlFor>, which Pipeline and
       * the compliance desk have used since they were written.
       *
       * Measured as geometry rather than as markup: a class can be present
       * and still not produce the layout, and the layout is the thing that
       * was wrong.
       */
      const gaps = await page.locator('.filters .filter').evaluateAll((wraps) =>
        wraps.map((w) => {
          const label = w.querySelector('label');
          const control = w.querySelector('select, input');
          if (!label || !control) return null;
          const l = label.getBoundingClientRect();
          const c = control.getBoundingClientRect();
          return { stacked: c.top >= l.bottom - 1, overlap: c.left < l.right && c.top < l.bottom };
        }),
      );
      check('every filter is wrapped the house way', gaps.includes(null), false);
      truthy(
        `every label sits above its control (${JSON.stringify(gaps)})`,
        gaps.length > 0 && gaps.every((g) => g.stacked && !g.overlap),
      );

      /*
       * AND EVERY STATUS OPTION IS A STATUS THE DATABASE HAS. The list said
       * 'closed', which is not one of the four in 0012, so that option
       * matched zero rows -- while omitting 'completed', which is what every
       * imported 2025 grant actually is.
       */
      check(
        'the status options are the ones the schema defines',
        await page.locator('#awards-status option').evaluateAll((os) =>
          os.map((o) => o.value).filter((v) => v !== ''),
        ),
        ['pending', 'active', 'completed', 'cancelled'],
      );
      check('unfiltered, the count is the whole count', await page.locator('.panel-head .meta').innerText(), '3 of 3');

      const body = await page.locator('tbody').innerText();
      /*
       * These three must be three different sentences. "Nothing asked yet" is
       * the Foundation's own omission; "1 overdue" is the grantee's; "All in"
       * is a clean record. A dash for the first would read as the third.
       */
      truthy('a grant nobody has asked for says so', /Nothing asked yet/i.test(body));
      truthy('an overdue grant is marked', /1 overdue/.test(body));
      /*
       * "Nothing outstanding", not "All in" -- idiom, and wrong besides: the
       * branch also covers a WAIVED report, which is settled but not received.
       */
      truthy('and a settled one reads as settled', /Nothing outstanding/i.test(body));
      /*
       * "Never", not "no account". The awards importer creates an account for
       * every imported grant, so an account existing proves nothing -- which
       * is why this column asked the wrong question at first and read "can
       * sign in: yes" for thirteen nonprofits who had never opened the system.
       */
      truthy('a grantee who has never signed in is findable by eye', /\bNever\b/.test(body));
      // The house date format, not an ISO slice: the compliance desk says
      // "December 3, 2026" and these screens used to say "2026-12-03".
      truthy('and one who has shows the date', /September 28, 2026/.test(body));

      falsy(
        'no null, undefined or NaN reaches the screen',
        /\bnull\b|\bundefined\b/i.test(await page.locator('main').innerText()) ||
          /\bNaN\b/.test(await page.locator('main').innerText()),
      );
      falsy('no console errors', errors.length > 0);

      // Filtering: the count must not claim to be the whole count.
      await page.locator('#awards-outstanding').selectOption('true');
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 1,
        undefined,
        { timeout: 10_000 },
      );
      truthy(
        'a filtered list does not report the unfiltered total',
        /with something outstanding/i.test(await page.locator('.panel-head .meta').innerText()),
      );
      check(
        'and the filter is in the address, so the list is a link',
        new URL(page.url()).searchParams.get('outstanding'),
        'true',
      );

      await page.locator('#awards-outstanding').selectOption('');
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 3,
        undefined,
        { timeout: 10_000 },
      );
      await page.getByRole('button', { name: 'Open the grant for Bayou Harbor Trust' }).click();
      await page.waitForURL(`${base}/awards/aw-1`, { timeout: 10_000 });
      check('a row reaches the grant', new URL(page.url()).pathname, '/awards/aw-1');
      await page.close();
    }

    // ---- the organizations list -------------------------------------------
    {
      const errors = [];
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await stubApi(page);
      await page.goto(`${base}/organizations`);
      await page.locator('tbody tr').first().waitFor({ timeout: 10_000 });

      check('every organization is listed', await page.locator('tbody tr').count(), ORGS.length);
      const body = await page.locator('tbody').innerText();
      truthy('an EIN is shown as it is printed', /87-1234567/.test(body));
      truthy('a missing EIN does not print null', /—/.test(body));
      /*
       * A nonprofit that has never been funded has a total, and it is nothing.
       * An empty cell in a money column reads as missing data.
       */
      truthy('an unfunded nonprofit has a zero, not a blank', /\$0\b/.test(body));
      truthy(
        'a funded nonprofit nobody has signed in from says what that means',
        /nothing has reached them/i.test(body),
      );
      falsy(
        'no null, undefined or NaN reaches the screen',
        /\bnull\b|\bundefined\b/i.test(await page.locator('main').innerText()) ||
          /\bNaN\b/.test(await page.locator('main').innerText()),
      );
      falsy('no console errors', errors.length > 0);

      // The filter that is the reason to open this screen.
      const lead = page.locator('.filter-lead button');
      check(
        'the filter is phrased as the question',
        await lead.innerText(),
        'Which grantees have never signed in?',
      );
      check('and is not pressed to begin with', await lead.getAttribute('aria-pressed'), 'false');
      await lead.click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 1,
        undefined,
        { timeout: 10_000 },
      );
      check('it narrows to the funded ones nobody can reach', await page.locator('tbody tr').count(), 1);
      truthy(
        'and the never-funded nonprofit is not swept in',
        !/Never Funded Society/.test(await page.locator('tbody').innerText()),
      );
      check('pressed state is announced', await lead.getAttribute('aria-pressed'), 'true');
      /*
       * AND IT LOOKS DIFFERENT. The first version styled the pressed state
       * blue, which changed nothing because `.btn` is already blue-filled --
       * the one control on this screen that exists to be switched gave no
       * sign of whether it was on. Compared as rendered colour, because that
       * is the only thing that could have caught it.
       */
      const onFill = await lead.evaluate((el) => getComputedStyle(el).backgroundColor);
      await lead.click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 3,
        undefined,
        { timeout: 10_000 },
      );
      const offFill = await lead.evaluate((el) => getComputedStyle(el).backgroundColor);
      truthy(`the toggle looks different on and off (${offFill} vs ${onFill})`, offFill !== onFill);
      await lead.click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 1,
        undefined,
        { timeout: 10_000 },
      );
      check(
        'and it is in the address',
        new URL(page.url()).searchParams.get('never_signed_in'),
        'true',
      );

      await page.getByRole('button', { name: 'Open Bayou Harbor Trust' }).click();
      await page.waitForURL(/\/organizations\/org-1/, { timeout: 10_000 });
      check('a row reaches the nonprofit', new URL(page.url()).pathname, '/organizations/org-1');
      await page.close();
    }

    // ---- the good-news empty state ----------------------------------------
    {
      const page = await browser.newPage();
      await page.route('**/api/**', async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === '/api/session') {
          return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
        }
        if (p === '/api/organizations') return json(route, { rows: [], total: 9 });
        if (p === '/api/programs') return json(route, { programs: [] });
        if (p === '/api/cycles') return json(route, { cycles: [] });
        if (p === '/api/forms') return json(route, { forms: [] });
        return json(route, {});
      });
      await page.goto(`${base}/organizations?never_signed_in=true`);
      await page.locator('.empty-reason').waitFor({ timeout: 10_000 });
      truthy(
        'every grantee having signed in reads as good news, not a broken screen',
        /Nothing to chase/i.test(await page.locator('.empty-reason').innerText()),
      );
      await page.close();
    }

    // ---- phone width -------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      await stubApi(page);
      await page.goto(`${base}/awards`);
      await page.locator('tbody tr').first().waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      await page.close();
    }

    for (const [name, path] of [
      ['grants', '/awards'],
      ['organizations', '/organizations'],
    ]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({
          colorScheme: scheme,
          viewport: { width: 1280, height: 800 },
        });
        const page = await ctx.newPage();
        await stubApi(page);
        await page.goto(`${base}${path}`);
        await page.locator('tbody tr').first().waitFor({ timeout: 10_000 });
        await page.screenshot({ path: `/tmp/list-${name}-${scheme}.png`, fullPage: true });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
