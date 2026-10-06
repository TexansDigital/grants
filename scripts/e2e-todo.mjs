/**
 * The To Do screen, driven in a real browser.
 *
 *   npm run e2e:todo
 *
 * WHY THIS EXISTS. This screen's entire value is a promise: if the list is
 * empty, nothing is outstanding. A promise like that fails in two directions,
 * and only one of them is visible in unit tests.
 *
 * The first direction is covered by test/todo.test.ts: an obligation that
 * exists but never reaches the list. The second can only be seen rendered --
 * the list fails to LOAD and the screen says "you're all caught up", because
 * a null and an empty array look the same to a component that does not
 * distinguish them. That is the single most consequential wrong impression
 * this application can give: one person runs this Foundation's grantmaking,
 * and this is the screen they will trust to tell them whether to look further.
 * CLAUDE.md: "No false green lights."
 *
 * So the checks below are, in order of what they protect:
 *   1. A failed load reads as a failure, never as nothing-to-do.
 *   2. An empty list says so in words that claim only what is true.
 *   3. Every kind of obligation renders, grouped, urgent ones first.
 *   4. The buttons go where they say, and are distinguishable to a screen
 *      reader reading the controls on their own.
 *   5. A reviewer's list renders without the admin-only kinds -- the server
 *      withholds them, and the screen must not fall over on their absence.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving:
 *   - Nothing about Cloudflare Access or the role guards. The API is a fixture
 *     here; `roles: STAFF_READ` and the admin gating inside todo() are enforced
 *     by the Worker and covered by test/todo.test.ts, not by this.
 *   - Nothing about the SQL. No database is touched.
 *   - It is not an accessibility test. It checks that an accessible name
 *     exists and is distinct, not how a screen reader announces the page.
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

/** A real file if there is one, the shell otherwise, as the Worker does. */
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

/*
 * Fixtures. Invented organizations, per CLAUDE.md, and shaped as the five
 * kinds in the order the module would emit them: claims and overdue first,
 * then the dates close enough to plan around.
 */
const ITEMS = [
  {
    id: 'claim:c1',
    kind: 'claim',
    title: 'Third Ward Futures',
    detail: 'Dana Reyes says we funded them in 2025. Find the grant and connect them, or decline.',
    href: '/past-grantees',
    dueAt: '2026-09-28T14:02:00.000Z',
    urgency: 'now',
  },
  {
    id: 'overdue:r1',
    kind: 'report_overdue',
    title: 'Bayou Harbor Trust',
    detail: '2025 progress update was due 2026-09-01 — 35 days ago. Nobody has asked them for it yet.',
    href: '/reporting?report=r1',
    dueAt: '2026-09-01T00:00:00.000Z',
    urgency: 'now',
  },
  {
    id: 'filed:r2',
    kind: 'report_filed',
    title: 'Harrisburg Arts Collective',
    detail: 'Filed their 2025 progress update. Read it and accept, or ask for more.',
    href: '/reporting?report=r2',
    dueAt: '2026-09-20T09:11:00.000Z',
    urgency: 'now',
  },
  {
    id: 'due:r3',
    kind: 'report_due',
    title: 'Sunnyside Food Project',
    detail: '2025 progress update is due in 9 days.',
    href: '/reporting?report=r3',
    dueAt: '2026-10-15T00:00:00.000Z',
    urgency: 'soon',
  },
  {
    id: 'file:f1',
    kind: 'files_due',
    title: 'Bayou Harbor Trust',
    detail: 'audited-financials-2024.pdf is due for destruction 2026-10-20.',
    href: '/retention',
    dueAt: '2026-10-20T00:00:00.000Z',
    urgency: 'soon',
  },
];

/** What a reviewer gets: the same shape, minus the two admin-only kinds. */
const REVIEWER_ITEMS = ITEMS.filter((i) => i.kind !== 'claim' && i.kind !== 'files_due');

async function stubApi(page, { role, todo, complete }) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role } });
    }
    if (p === '/api/todo') {
      // `null` means "answer with a server error", which is the case the
      // screen must not render as an empty list.
      if (todo === null) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong.' } }),
        });
      }
      return json(route, {
        items: todo,
        generatedAt: '2026-10-06T12:00:00.000Z',
        // Overridden by the one check that cares; everywhere else the list is
        // the whole list, which is the state the screen is designed around.
        complete: complete !== false,
      });
    }
    // Everything else the shell asks for on its way up.
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
    // ---- 1. a failed load must not read as "nothing to do" ----------------
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: null });
      await page.goto(`${base}/to-do`);
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 10_000 });
      const text = await alert.innerText();
      truthy('a failed load says the list is not showing anything', /not showing anything/i.test(text));
      truthy('and names somewhere else to look', /Reporting/.test(text) && /Past grantees/.test(text));
      falsy(
        'and never claims the Foundation is caught up',
        /caught up|nothing is waiting|all clear/i.test(text),
      );
      await page.close();
    }

    // ---- 2. empty means empty, and claims only that -----------------------
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: [] });
      await page.goto(`${base}/to-do`);
      await page.getByText('Nothing is waiting on you.').waitFor({ timeout: 10_000 });
      const body = await page.locator('.empty').innerText();
      truthy(
        'the empty state names what it covers, so "empty" means something',
        /claims/i.test(body) && /reports/i.test(body) && /files/i.test(body),
      );
      falsy('and no obligation rows are rendered', (await page.locator('.todo-item').count()) > 0);
      await page.close();
    }

    // ---- 3. every kind renders, urgent first ------------------------------
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await stubApi(page, { role: 'admin', todo: ITEMS });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });

      check('every obligation renders', await page.locator('.todo-item').count(), ITEMS.length);
      check(
        'in the order the module gave them',
        await page.locator('.todo-who').allInnerTexts(),
        ITEMS.map((i) => i.title),
      );
      /*
       * Lower-cased before comparing: the headings and the badges are set in
       * caps by CSS, so innerText reads back uppercase. The assertion is about
       * the words, not the styling.
       */
      check(
        'the urgent ones are grouped under a heading a person would say',
        (await page.locator('.todo-group h3').allInnerTexts()).map((t) => t.toLowerCase()),
        ['needs you now', 'coming up'],
      );
      /*
       * The count is the number of things outstanding. If it ever disagrees
       * with the rows, the screen is lying about the one number on it.
       */
      check('the count matches the rows', await page.locator('.count').innerText(), String(ITEMS.length));
      check(
        'an overdue report is the one row marked in red',
        (await page.locator('.badge-danger').allInnerTexts()).map((t) => t.toLowerCase()),
        ['overdue'],
      );
      /*
       * The left edge carries urgency independently of the heading, for a
       * reader who has scrolled past it.
       */
      check(
        'each row carries its own urgency',
        await page.locator('.todo-item').evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-urgency')),
        ),
        ITEMS.map((i) => i.urgency),
      );
      falsy('no console errors while rendering the list', errors.length > 0);
      await page.close();
    }

    // ---- 4. the buttons name the job, and are told apart ------------------
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: ITEMS });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });

      const names = await page
        .locator('.todo-item button')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      check(
        'every row has an accessible name, and no two are the same',
        new Set(names).size,
        ITEMS.length,
      );
      truthy(
        'the visible label names the job rather than the tab',
        (await page.locator('.todo-item').nth(2).locator('button').innerText()) === 'Read report',
      );

      // And it navigates. The claim row is first, and goes to the queue.
      await page.locator('.todo-item').first().locator('button').click();
      await page.waitForURL(`${base}/past-grantees`, { timeout: 10_000 });
      check('the row goes where it says', new URL(page.url()).pathname, '/past-grantees');
      await page.close();
    }

    // ---- 5. '/' lands here, and the nav offers it first -------------------
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: ITEMS });
      await page.goto(`${base}/`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });
      truthy('opening the app lands on what needs a person', true);
      check(
        'and the nav offers it first',
        await page.locator('.mainnav button').first().innerText(),
        'To do',
      );
      check(
        'marked as the current page',
        await page.locator('.mainnav button').first().getAttribute('aria-current'),
        'page',
      );
      await page.close();
    }

    // ---- 6. a reviewer's list renders without the admin-only kinds --------
    {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await stubApi(page, { role: 'reviewer', todo: REVIEWER_ITEMS });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });

      check('a reviewer gets their own rows', await page.locator('.todo-item').count(), REVIEWER_ITEMS.length);
      falsy(
        'and is shown no claim or retention row',
        (await page.locator('.todo-item .badge', { hasText: /^Claim$|^File$/ }).count()) > 0,
      );
      falsy('without a console error on the missing kinds', errors.length > 0);
      await page.close();
    }

    // ---- 7. a truncated list admits it ------------------------------------
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: ITEMS, complete: false });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });
      const text = await page.locator('.todo-partial').innerText();
      truthy('a truncated list says it is not all of them', /not all of them/i.test(text));
    }

    // An empty page that is NOT the whole story must never read as caught up.
    {
      const page = await browser.newPage();
      await stubApi(page, { role: 'admin', todo: [], complete: false });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-partial').waitFor({ timeout: 10_000 });
      falsy(
        'and an empty truncated list is not reported as nothing outstanding',
        await page.locator('.empty').count(),
      );
      await page.close();
    }

    // ---- 8. it holds together at phone width ------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      await stubApi(page, { role: 'admin', todo: ITEMS });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      /*
       * AND THE TEXT STILL HAS A LINE TO ITSELF. The overflow check above
       * passed on a layout where the organization name was squeezed into a
       * forty-pixel column and broken mid-word -- no scrollbar, and unreadable.
       * A row is only laid out correctly if its text takes most of the width.
       */
      const share = await page.locator('.todo-item').first().evaluate((row) => {
        const text = row.querySelector('.todo-text');
        return text.getBoundingClientRect().width / row.getBoundingClientRect().width;
      });
      truthy(`the name has the line to itself (text took ${Math.round(share * 100)}%)`, share > 0.7);
      await page.screenshot({
        path: process.env.TODO_SHOT_NARROW ?? '/tmp/todo-narrow.png',
        fullPage: true,
      });
      await page.close();
    }

    // A picture of the real thing, for a human to look at. Both themes: the
    // internal surfaces are dark-themed and the palette is defined per token,
    // so a colour that only works on one ground is invisible until rendered.
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const p2 = await ctx.newPage();
      await stubApi(p2, { role: 'admin', todo: ITEMS });
      await p2.goto(`${base}/to-do`);
      await p2.locator('.todo-item').first().waitFor({ timeout: 10_000 });
      await p2.screenshot({ path: `/tmp/todo-${scheme}.png`, fullPage: true });
      await ctx.close();
    }
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await stubApi(page, { role: 'admin', todo: ITEMS });
      await page.goto(`${base}/to-do`);
      await page.locator('.todo-item').first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: process.env.TODO_SHOT ?? '/tmp/todo.png', fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
