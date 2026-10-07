/**
 * The compliance desk, driven in a real browser.
 *
 *   npm run e2e:reports
 *
 * WHY A HARNESS FOR A TABLE. Two of the three things wrong with this screen
 * were invisible to every unit test and to the type checker, and one of them
 * had been shipping for weeks:
 *
 *   1. CLICKING A ROW APPEARED TO DO NOTHING. The detail panel renders after
 *      the table, so with thirteen rows it opened some 500px below the bottom
 *      of a laptop window and the page did not move. Nothing about that is
 *      expressible as "the component rendered"; it is a fact about geometry
 *      at a given viewport, which is what a browser is for.
 *
 *   2. THE FILTER CAPTIONS WERE 16px BODY TEXT. `internal.css` styles
 *      `.filter label`, and this screen alone wrote `<label class="filter">`
 *      with a bare <span> inside -- so the rule matched nothing and the least
 *      important text on the screen rendered larger than the column headings
 *      and every value in the table. A markup shape that matches no rule is
 *      not an error anywhere; it just looks wrong.
 *
 * So this file measures what it claims. The type-treatment census is the
 * unusual one: it counts every distinct combination of size, weight, case and
 * colour that a reader actually meets in the main region, and fails if that
 * number grows. "So many fonts and font sizes" was the report from the person
 * using this, and a number is the only form of that complaint a machine can
 * hold on to.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving:
 *   - Nothing about authorization. The API is a fixture; `roles` and the admin
 *     gating are enforced by the Worker and covered by the vitest suite.
 *   - Nothing about the SQL, the banding of REAL data, or `isOverdue`. The
 *     bands are covered by test/reportBands.test.ts against the shared
 *     definition in src/lib/reportDue.ts.
 *   - It is not an accessibility test. It checks that a heading row carries
 *     `scope="colgroup"` and that focus lands somewhere sensible. It cannot
 *     tell you how a screen reader announces a banded table, and nobody has
 *     listened to this one.
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

/*
 * A portfolio shaped like the real one: thirteen grants, most of them sitting
 * scheduled because nobody has asked yet, with one of each exception.
 *
 * NOTE ON `overdue`. It is the server's flag, from the single definition in
 * src/lib/reportDue.ts, and that definition never marks a FILED report
 * overdue -- a report already with staff is our queue, not the nonprofit's
 * failure. These fixtures obey that, because a fixture the server cannot
 * produce proves nothing about the screen.
 */
const NAMES = [
  'Alief ISD Education Foundation',
  'Boys & Girls Clubs of Greater Houston',
  'Communities In Schools of Houston',
  'DePelchin Children’s Center',
  'Harris County Department of Education',
  'Houston Area Urban League',
  'Houston Food Bank',
  'Legacy Community Health',
  'SEARCH Homeless Services',
  'Star of Hope Mission',
  'Texas Children’s Hospital',
  'The Women’s Home',
  'YMCA of Greater Houston',
];

const base = NAMES.map((organizationName, i) => ({
  reportPeriodId: `rp${i}`,
  awardId: `aw${i}`,
  organizationId: `og${i}`,
  organizationName,
  programName: 'Inspire Change',
  label: 'Final report',
  periodType: 'final',
  dueDate: '2026-12-03',
  status: 'scheduled',
  awardedAmountCents: [2500000, 5000000, 1500000, 3500000, 2000000][i % 5],
  submittedAt: null,
  fundsSpentCents: null,
  daysUntilDue: 57,
  overdue: false,
  reminderCount: 0,
  reminderLastSentAt: null,
}));

const rows = base.map((r, i) => {
  if (i === 2) return { ...r, status: 'submitted', submittedAt: '2026-09-20', fundsSpentCents: 1480000 };
  if (i === 7) return { ...r, status: 'submitted', submittedAt: '2026-07-14', fundsSpentCents: 1500000 };
  if (i === 5) return { ...r, status: 'open', daysUntilDue: -21, overdue: true };
  if (i === 6)
    return {
      ...r,
      status: 'open',
      daysUntilDue: -45,
      overdue: true,
      reminderCount: 2,
      reminderLastSentAt: '2026-09-28',
    };
  if (i === 11) return { ...r, status: 'revisions_requested', daysUntilDue: 12, submittedAt: '2026-09-02' };
  if (i === 9) return { ...r, status: 'accepted', submittedAt: '2026-08-11', fundsSpentCents: 2000000 };
  if (i === 4) return { ...r, status: 'waived' };
  return r;
});

const DETAIL = {
  period: { id: 'rp2', label: 'Final report', dueDate: '2026-12-03', status: 'submitted', waivedReason: null },
  award: {
    id: 'aw2',
    organizationName: 'Communities In Schools of Houston',
    programName: 'Inspire Change',
    awardedAmountCents: 1500000,
  },
  submissions: [
    {
      id: 's1',
      submittedAt: '2026-09-20',
      submittedBy: 'maria@example.org',
      acceptedAt: null,
      adminFeedback: null,
      metrics: [
        { metricKey: 'served', label: 'Individuals served', metricType: 'integer', display: '1,240' },
        { metricKey: 'hours', label: 'Volunteer hours', metricType: 'integer', display: '860' },
        /* A prose metric, which falls through to the answer list rather than
           being typeset as a headline figure. */
        {
          metricKey: 'pops',
          label: 'Populations served',
          metricType: 'text',
          display: 'Students in grades 6\u201312 across four Alief campuses.',
        },
      ],
      answers: [
        {
          fieldKey: 'narrative',
          label: 'What the grant paid for',
          display:
            'Two full-time campus coordinators at Alief Taylor and Alief Elsik, plus the attendance-tracking software the district would not fund, and a part-time data clerk for the first two terms.',
        },
        { fieldKey: 'metric_served', label: 'Individuals served', display: '1,240' },
        {
          fieldKey: 'metric_pops',
          label: 'Populations served',
          display: 'Students in grades 6\u201312 across four Alief campuses.',
        },
        /* The one a grantee skipped. It comes back as '', not null. */
        { fieldKey: 'next', label: 'What you would do differently', display: '' },
      ],
      attachments: [
        { id: 'f1', filename: 'cis-houston-final-budget-reconciliation-2025.pdf', sizeBytes: 184320 },
      ],
    },
  ],
};

async function stubApi(page, body = rows) {
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: 'staff@example.org', role: 'admin' } });
    }
    if (p === '/api/reports') return json(route, { rows: body, total: body.length });
    if (p.startsWith('/api/reports/')) return json(route, DETAIL);
    if (p === '/api/programs') return json(route, { programs: [{ id: 'p1', name: 'Inspire Change' }] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    return json(route, {});
  });
}

/** Wait for a smooth scroll to stop moving. */
async function scrollSettled(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        let last = -1;
        let still = 0;
        const tick = () => {
          if (window.scrollY === last) {
            still += 1;
            if (still > 4) return resolve(true);
          } else {
            still = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    null,
    { timeout: 10_000 },
  );
}

async function main() {
  const root = normalize(join(process.cwd(), 'public'));
  const { server, port } = await serveAssets(root);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });

  try {
    // ---- the bands --------------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page);
      await page.goto(`${origin}/reporting`);
      await page.locator('table').waitFor({ timeout: 10_000 });

      check(
        'the desk opens with what needs doing, not with a due-date sort',
        await page.locator('.band-name').evaluateAll((els) => els.map((e) => e.textContent.trim())),
        ['Waiting on us', 'Late', 'Still to come', 'Settled'],
      );
      check(
        'and each band says how many',
        await page.locator('tr.band .count').evaluateAll((els) => els.map((e) => e.textContent.trim())),
        ['2', '2', '7', '2'],
      );
      /*
       * EVERY ROW, EXACTLY ONCE. The bands are a view of the list, not a
       * filter on it, and a screen promising "every obligation" must not be
       * able to drop one between bands.
       */
      check(
        'and every obligation is on the screen exactly once',
        await page.locator('tbody tr:not(.band)').count(),
        rows.length,
      );
      check(
        'with the longest-waiting at the top of our own queue',
        (await page.locator("tbody[data-band='ours'] .rowlink").first().textContent()).trim(),
        'Legacy Community Health',
      );
      check(
        'and the most overdue at the top of the late band',
        (await page.locator("tbody[data-band='late'] .rowlink").first().textContent()).trim(),
        'Houston Food Bank',
      );
      /*
       * A report we are already holding is not the nonprofit's failure. It
       * says when it arrived, not how late the date was.
       */
      const ours = page.locator("tbody[data-band='ours'] tr:not(.band)").first();
      check(
        'a filed report shows when it arrived, with no late marker against it',
        await ours.locator("[data-overdue='true']").count(),
        0,
      );
      truthy(
        'and says the date it was filed',
        (await ours.textContent()).includes('Filed July 14, 2026'),
      );
      check(
        'the heading row is a heading for its group, not a cell',
        await page.locator('tr.band th').first().getAttribute('scope'),
        'colgroup',
      );
      check('the blunt column name is gone', await page.locator('thead th').nth(4).textContent(), 'Reminders');

      // ---- the type census ------------------------------------------------
      const treatments = await page.evaluate(() => {
        const seen = new Map();
        for (const el of document.querySelectorAll('main *')) {
          // Only elements with their own text, and never the inside of a
          // native select popup, which the platform draws.
          if (el.tagName === 'OPTION') continue;
          const text = [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent.trim())
            .join(' ')
            .trim();
          if (!text) continue;
          const s = getComputedStyle(el);
          const key = [s.fontSize, s.fontWeight, s.textTransform, s.color].join('|');
          if (!seen.has(key)) seen.set(key, { key, sample: text.slice(0, 30) });
        }
        return [...seen.values()];
      });
      const sizes = [...new Set(treatments.map((t) => t.key.split('|')[0]))].sort(
        (a, b) => parseFloat(b) - parseFloat(a),
      );
      console.log(`        sizes in play: ${sizes.join(', ')}`);
      /*
       * FOUR SIZES, EACH WITH ONE JOB: the screen name, a band heading, the
       * body and its labels, a badge. It was four before this work too, but
       * one of them was doing two jobs -- 16px was both a band-level heading
       * and a filter caption -- which is what "no real structure" felt like.
       */
      check('four type sizes, and no more', sizes.length, 4);
      check(
        'the filter captions sit with the other small labels, not above them',
        await page.locator("label[for='reports-program']").evaluate((e) => getComputedStyle(e).fontSize),
        '13px',
      );
      check(
        'and the late marker is the size of the cell it sits in',
        await page
          .locator("tbody[data-band='late'] [data-overdue='true']")
          .first()
          .evaluate((e) => getComputedStyle(e).fontSize),
        '13px',
      );

      // ---- badge weight ----------------------------------------------------
      /*
       * The heaviest mark goes on the row that needs somebody, not on the one
       * that is finished. Compared as rendered, because "I set a class" is not
       * the claim -- "it looks heavier" is.
       */
      const filled = await page
        .locator("tbody[data-band='ours'] .badge")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor);
      const settled = await page
        .locator("tbody[data-band='settled'] .badge")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor);
      truthy('the row waiting on us carries the filled badge', filled !== 'rgba(0, 0, 0, 0)');
      check('and a settled one does not', settled, 'rgba(0, 0, 0, 0)');

      // ---- housekeeping is last -------------------------------------------
      const order = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          b.textContent.includes('Create missing report obligations'),
        );
        const table = document.querySelector('table');
        return btn && table
          ? btn.getBoundingClientRect().top > table.getBoundingClientRect().bottom
          : null;
      });
      truthy('the once-a-year maintenance button is below the data, not above it', order);

      await page.close();
    }

    // ---- opening a report -------------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page);
      await page.goto(`${origin}/reporting`);
      await page.locator('table').waitFor({ timeout: 10_000 });

      await page.locator("tbody[data-band='ours'] .rowlink").first().click();
      await page.locator('#report-detail-heading').waitFor({ timeout: 10_000 });
      await scrollSettled(page);

      /*
       * THE CHECK THIS FILE EXISTS FOR. Before the scroll, this panel opened
       * at y=1328 in an 800px window with the page at scrollY=0 -- about 500px
       * below the bottom edge, so clicking a nonprofit's name looked like it
       * did nothing at all.
       */
      const seen = await page.locator('section.panel').last().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight };
      });
      console.log(`        panel at top=${seen.top} in a ${seen.h}px window`);
      truthy(
        'the report you clicked is on the screen you are looking at',
        seen.top >= 0 && seen.top < seen.h,
      );

      /* And the keyboard goes with it. */
      check(
        'focus moves into the panel rather than staying on a row behind it',
        await page.evaluate(() => {
          const el = document.activeElement;
          return el ? el.closest('section.panel') !== null : false;
        }),
        true,
      );

      // Closing puts you back where you were.
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForTimeout(100);
      check(
        'and closing it returns focus to the row it came from',
        await page.evaluate(() => document.activeElement?.getAttribute('data-report-row')),
        'rp7',
      );
      check('with the report gone from the address', new URL(page.url()).search, '');

      await page.close();
    }

    // ---- the panel itself -------------------------------------------------
    /*
     * The panel reads in three parts -- the facts, what the grantee said, what
     * you do about it -- and it used to read as one column with the parts
     * running into each other. Every check here was a measurement first.
     */
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await stubApi(page);
      await page.goto(`${origin}/reporting?report=rp2`);
      await page.locator('#report-detail-heading').waitFor({ timeout: 10_000 });

      /*
       * THE FIGURES AND THE PROSE WERE TOUCHING. Measured at zero pixels
       * apart: the bottom of the "1,240" tile and the top of the first answer
       * were at the same y, so a 34px number and a 13px label sat in one
       * block with nothing to say which belonged to which.
       */
      const gap = await page.evaluate(() => {
        const tile = document.querySelector('.bignum');
        const answer = document.querySelector('.report-answer');
        if (!tile || !answer) return null;
        return Math.round(answer.getBoundingClientRect().top - tile.getBoundingClientRect().bottom);
      });
      console.log(`        figures to prose: ${gap}px`);
      truthy('the figures do not run into the answers below them', gap !== null && gap >= 24);

      /*
       * AND THE LABEL SITS ABOVE ITS ANSWER. It was 405px to the left: a
       * thirteen-character label holding open a third of the panel while the
       * prose began a third of the way across it.
       */
      const layout = await page.evaluate(() => {
        const dt = document.querySelector('.report-answer dt');
        const dd = document.querySelector('.report-answer dd');
        if (!dt || !dd) return null;
        const a = dt.getBoundingClientRect();
        const b = dd.getBoundingClientRect();
        return { offsetX: Math.round(b.left - a.left), below: b.top > a.top, measure: Math.round(b.width) };
      });
      check('the label is directly above its answer', layout && layout.offsetX, 0);
      truthy('and the answer is under it, not beside it', layout && layout.below);
      /*
       * Prose wants a measure. Across a 1280px panel a paragraph runs past 150
       * characters a line, which is read by losing your place and starting
       * again.
       */
      console.log(`        prose measure: ${layout && layout.measure}px`);
      truthy('and the prose has a measure rather than the panel width', layout && layout.measure <= 720);

      /*
       * A FIELD THE GRANTEE SKIPPED SAYS SO. `??` catches null and an unasked
       * field comes back as '', so the label rendered with nothing under it
       * and the box below slid up to meet it. CLAUDE.md: no dangling labels.
       */
      const skipped = page.locator('.report-answer').filter({ hasText: 'What you would do differently' });
      check('an unanswered field says so rather than leaving its label bare',
        (await skipped.locator('dd').innerText()).trim(), 'Not answered');

      /* The three regions are actually divided. */
      for (const [what, sel] of [
        ['the figures from the prose', '.report-metrics'],
        ['the prose from the files', '.report-files'],
        ['and the waive control from the decision above it', '.danger-row'],
      ]) {
        const w = await page.locator(sel).evaluate((el) => {
          const s = getComputedStyle(el);
          return parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
        });
        truthy(`a rule separates ${what}`, w >= 1);
      }
      truthy(
        'and the files say whose they are',
        (await page.locator('.report-files h5').innerText()).trim().length > 0,
      );

      /*
       * WHO FILED IT SITS BESIDE WHEN. Giving the submission heading `flex: 1`
       * -- copied from the h3 rule -- pushed the address to the far right edge
       * of the panel, 1,100px from the date it belongs to.
       */
      const apart = await page.evaluate(() => {
        const h = document.querySelector('.review-head h4');
        const who = document.querySelector('.review-head .meta');
        if (!h || !who) return null;
        /*
         * MEASURE THE TEXT, NOT THE BOX. Measuring to the heading's right edge
         * reported the same small gap either way: `flex: 1` stretches the BOX
         * across the panel, so the address stays just after its right edge
         * while sitting 1,100px from the words a reader sees. A Range over the
         * text node gives where the writing actually stops.
         */
        const r = document.createRange();
        r.selectNodeContents(h);
        return Math.round(who.getBoundingClientRect().left - r.getBoundingClientRect().right);
      });
      console.log(`        filer sits ${apart}px from the date`);
      truthy('the address stays next to the date it belongs to', apart !== null && apart < 120);

      // ---- the panel's own type census -------------------------------------
      const panelSizes = await page.evaluate(() => {
        const panel = document.querySelectorAll('section.panel');
        const el = panel[panel.length - 1];
        const seen = new Set();
        for (const n of el.querySelectorAll('*')) {
          if (n.tagName === 'OPTION') continue;
          const text = [...n.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent.trim()).join('').trim();
          if (!text) continue;
          seen.add(getComputedStyle(n).fontSize);
        }
        return [...seen].sort((a, b) => parseFloat(b) - parseFloat(a));
      });
      console.log(`        panel sizes: ${panelSizes.join(', ')}`);
      /*
       * THREE, not the list's four: the reported figure (36px), the submission
       * heading and the controls (16px), and everything else (13px -- body,
       * and the small caps labelling it). The panel has no badge, which is
       * why it needs one level fewer than the list does.
       *
       * Asserted exactly rather than as a ceiling. A fourth size is not
       * automatically wrong, but it means a role has been added, and whoever
       * adds it should have to say what the role is.
       */
      check('the panel holds to three type sizes', panelSizes, ['36px', '16px', '13px']);

      /* The decision is reachable without a mouse. */
      await page.locator('#report-feedback').focus();
      await page.keyboard.press('Tab');
      check(
        'and Tab from the notes box reaches the decision',
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        'Accept this report',
      );

      await page.close();
    }

    // ---- an unknown status must not vanish --------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await stubApi(page, [{ ...base[0], status: 'invented_in_a_later_migration' }]);
      await page.goto(`${origin}/reporting`);
      await page.locator('table').waitFor({ timeout: 10_000 });
      check(
        'a status this screen has no rule for is shown and named, not dropped',
        await page.locator('.band-name').textContent(),
        'Not recognised',
      );
      check('and the row itself is there', await page.locator('tbody tr:not(.band)').count(), 1);
      await page.close();
    }

    // ---- phone, and both themes -------------------------------------------
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
      await stubApi(page);
      await page.goto(`${origin}/reporting`);
      await page.locator('table').waitFor({ timeout: 10_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('no sideways scroll at 390px', overflow <= 0, true);
      await page.close();
    }

    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 1100 } });
      const page = await ctx.newPage();
      await stubApi(page);
      await page.goto(`${origin}/reporting`);
      await page.locator('table').waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `/tmp/reports-${scheme}.png`, fullPage: true });
      /* The controls must keep their own text colour in both themes. */
      const ink = await page
        .locator("select#reports-program")
        .evaluate((e) => getComputedStyle(e).color);
      console.log(`        ${scheme}: select text ${ink}`);
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
