/**
 * The navigation, driven in a real browser.
 *
 *   npm run e2e:nav
 *
 * WHY A HARNESS FOR A NAV BAR. It reached twelve items and wrapped onto a
 * second line, at which point a navigation stops being a map and becomes a
 * search problem: the reader scans every label every time, because nothing
 * tells them which few matter. The fix -- six in the bar, the rest behind
 * "More" -- introduces three ways to be wrong that no unit test can see:
 *
 *   1. It still wraps. The entire point was one line at a normal width.
 *   2. Opening something from the menu leaves nothing highlighted, so the
 *      reader cannot tell where they are.
 *   3. The menu cannot be dismissed, or cannot be dismissed the way the
 *      person reached for -- background click for a mouse, Escape for a
 *      keyboard. A menu that answers one and not the other is broken for
 *      half its users.
 *
 * It also checks the two second views, because moving Reporting under Grants
 * and the claims queue under Organizations is only an improvement if being on
 * either still tells you which section you are in.
 *
 * WHAT IT DOES NOT PROVE: nothing about Cloudflare Access or the role guards.
 * The API is a fixture. The reviewer pass here checks what is OFFERED, not
 * what is permitted -- the server enforces that and the unit tests cover it.
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

async function stubApi(page, role) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p === '/api/todo') return json(route, { items: [], generatedAt: 'x', complete: true });
    if (p === '/api/awards') return json(route, { rows: [], total: 0 });
    if (p === '/api/organizations') return json(route, { rows: [], total: 0 });
    if (p === '/api/reports') return json(route, { rows: [], total: 0 });
    if (p === '/api/grantee-claims') return json(route, { claims: [] });
    if (p === '/api/impact') {
      return json(route, { generatedAt: 'x', year: null, years: [], programs: [] });
    }
    if (p === '/api/retention') return json(route, { upcoming: [], purged: [] });
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });
    if (p === '/api/applications') return json(route, { applications: [], total: 0 });
    return json(route, {});
  });
}

/** The labels in the bar, in order. */
const barLabels = (page) =>
  page.locator('.mainnav > button').evaluateAll((els) => els.map((e) => e.innerText.trim()));

async function main() {
  const root = normalize(join(process.cwd(), 'public'));
  const { server, port } = await serveAssets(root);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  // A render error becomes a named failure rather than a locator timeout.
  watchRenderErrors(browser, (m) => check(m, false, true));
  try {
    // ---- an admin ---------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page, 'admin');
      await page.goto(`${base}/to-do`);
      await page.locator('.mainnav').waitFor({ timeout: 10_000 });

      check(
        'the bar carries what is used week to week, named as nouns',
        await barLabels(page),
        ['To do', 'Grants', 'Organizations', 'Applications', 'Impact', 'Results'],
      );

      /*
       * ONE LINE. The entire reason for the More menu. Measured as rendered
       * height against a single button's height, because "six items" does not
       * guarantee one row at any particular width.
       */
      const rows = await page.locator('.mainnav').evaluate((nav) => {
        const btn = nav.querySelector('button');
        return Math.round(nav.getBoundingClientRect().height / btn.getBoundingClientRect().height);
      });
      check('and it fits on one line at 1280px', rows, 1);

      // The menu holds the rest.
      const toggle = page.getByRole('button', { name: /^More/ });
      check('the menu is closed to begin with', await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      check(
        'and holds what is reached occasionally',
        await page
          .locator('.navmore-menu button')
          .evaluateAll((els) => els.map((e) => e.innerText.trim())),
        ['My reviews', 'Data health', 'Retention', 'Programs'],
      );

      // Dismissal, both ways.
      await page.keyboard.press('Escape');
      check('Escape closes it', await page.locator('.navmore-menu').count(), 0);
      await toggle.click();
      await page.locator('main').click({ position: { x: 10, y: 10 } });
      check('and a click outside closes it', await page.locator('.navmore-menu').count(), 0);

      /*
       * WHERE AM I. Opening something from the menu must leave the reader able
       * to tell -- otherwise nothing in the bar is marked and the screen looks
       * like it belongs to no section.
       */
      await toggle.click();
      await page.getByRole('button', { name: 'Retention' }).click();
      await page.waitForURL(`${base}/retention`, { timeout: 10_000 });
      /*
       * MARKED, BUT NOT WITH aria-current. Putting it on the toggle meant two
       * current-page controls in one nav whenever the menu was open -- this
       * one and the item inside it. The visual mark moved to a data
       * attribute, which the stylesheet keys on beside the real one.
       */
      check(
        'and the More button is marked when the open screen is inside it',
        await toggle.getAttribute('data-section-current'),
        'true',
      );
      falsy(
        'without claiming to be the current page itself',
        await toggle.getAttribute('aria-current'),
      );
      falsy(
        'and without promising menu behaviour it does not have',
        await toggle.getAttribute('aria-haspopup'),
      );
      check('with nothing else in the bar claiming to be current',
        await page.locator(".mainnav > button[aria-current='page']").count(), 0);

      await page.close();
    }

    // ---- the two second views ---------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page, 'admin');

      for (const [path, section, view] of [
        [`/reporting`, 'Grants', 'Reports'],
        [`/awards`, 'Grants', 'All grants'],
        [`/past-grantees`, 'Organizations', 'Past grantee claims'],
        [`/organizations`, 'Organizations', 'All organizations'],
      ]) {
        await page.goto(`${base}${path}`);
        await page.locator('.sectionnav').waitFor({ timeout: 10_000 });
        const current = await page
          .locator(".mainnav > button[aria-current='page']")
          .innerText();
        check(`${path} says it is in ${section}`, current.trim(), section);
        const viewCurrent = await page
          .locator(".sectionnav button[aria-current='page']")
          .innerText();
        check(`and that the view is ${view}`, viewCurrent.trim(), view);
      }

      // And the views reach each other.
      await page.goto(`${base}/awards`);
      await page.locator('.sectionnav').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Reports', exact: true }).click();
      await page.waitForURL(`${base}/reporting`, { timeout: 10_000 });
      check('a section view reaches its sibling', new URL(page.url()).pathname, '/reporting');
      await page.close();
    }

    // ---- a reviewer -------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page, 'reviewer');
      await page.goto(`${base}/to-do`);
      await page.locator('.mainnav').waitFor({ timeout: 10_000 });

      /*
       * "Rarely used" is a fact about a PERSON. My reviews is an admin's
       * occasional errand and a reviewer's entire job, so it is promoted into
       * the bar for them -- burying it would be the same mistake in the other
       * direction.
       */
      check(
        'a reviewer gets their own short bar, with their work in it',
        await barLabels(page),
        ['To do', 'Applications', 'My reviews', 'Programs'],
      );
      /*
       * PROGRAMS IS IN THE BAR, NOT BEHIND A MENU, and that is the rule
       * earning itself: it is the only thing a reviewer can see that is not
       * their daily work, so the split would have produced a dropdown with
       * one entry in it -- a click and a guess to reach something that fits
       * in the space the button occupies.
       */
      falsy(
        'and no More menu, because a one-item menu is worse than the item',
        await page.locator('.navmore').count(),
      );
      await page.close();
    }

    // ---- phone width -------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      await stubApi(page, 'admin');
      await page.goto(`${base}/to-do`);
      await page.locator('.mainnav').waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      // The menu must open inside the viewport rather than off the right edge.
      await page.getByRole('button', { name: /^More/ }).click();
      const off = await page.locator('.navmore-menu').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.right > document.documentElement.clientWidth || r.left < 0;
      });
      falsy('and the menu opens inside the screen', off);
      await page.close();
    }

    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1280, height: 420 },
      });
      const page = await ctx.newPage();
      await stubApi(page, 'admin');
      await page.goto(`${base}/awards`);
      await page.locator('.sectionnav').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: /^More/ }).click();
      await page.locator('.navmore-menu').waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `/tmp/nav-${scheme}.png` });
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
