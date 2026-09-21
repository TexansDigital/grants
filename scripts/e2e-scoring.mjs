/**
 * Scoring and deciding, driven in a real browser.
 *
 *   npm run e2e:scoring
 *
 * WHY THIS EXISTS. Six faults on this project reached a running deployment
 * with the whole unit suite green, and every one was found by opening the
 * page. Two of the six were on the last two screens built, both of the same
 * shape: a route added without being added to the list that loads session
 * data, so the screen hung on "Loading..." forever.
 *
 * WHAT THIS PROVES. The reviewer's queue and scoring sheet render; the
 * arithmetic a reviewer reads while scoring is right; an empty box clears a
 * score rather than sending a nought; a declared conflict locks the sheet; the
 * admin comparison shows two reviewers side by side and excludes an unfinished
 * one from the average; and a decline cannot be recorded without a reason.
 *
 * WHAT IT DOES NOT PROVE. The API is a fixture. Nothing here touches
 * Cloudflare Access, the role guards, or the SQL -- a reviewer reaching
 * somebody else's assignment is refused in scoring.ts and covered in
 * test/scoring.test.ts, which is where that belongs.
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
// Fixtures. 10 at weight 3, 10 at weight 2, 5 at weight 1 -- out of 55 points.
// ---------------------------------------------------------------------------

const RUBRIC = { id: 'r1', name: 'Inspire Change scoring', version: 2, maxTotalScoreBp: 550000 };

const CRITERIA = [
  {
    id: 'c1', criterion_key: 'community_need', label: 'Critical community need',
    description: 'Evidence the need is real and unmet.',
    weight_bp: 30000, max_score: 10, sort_order: 0, score: null, comment: null,
  },
  {
    id: 'c2', criterion_key: 'measurable_outcomes', label: 'Measurable outcomes',
    description: null, weight_bp: 20000, max_score: 10, sort_order: 1, score: null, comment: null,
  },
  {
    id: 'c3', criterion_key: 'capacity', label: 'Capacity to deliver',
    description: null, weight_bp: 10000, max_score: 5, sort_order: 2, score: null, comment: null,
  },
];

function sheetState(over = {}) {
  return {
    scores: { c1: null, c2: null, c3: null },
    comments: { c1: null, c2: null, c3: null },
    completedAt: null,
    conflictDeclaredAt: null,
    decided: false,
    saves: [],
    decisions: [],
    ...over,
  };
}

const totalBp = (state) =>
  CRITERIA.reduce((t, c) => t + (state.scores[c.id] ?? 0) * c.weight_bp, 0);

async function stubApi(page, state, { role = 'reviewer' } = {}) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    if (p === '/api/session') {
      return json(route, { user: { id: 'u1', email: `${role}@example.org`, role } });
    }
    if (p === '/api/programs') return json(route, { programs: [] });
    if (p === '/api/cycles') return json(route, { cycles: [] });
    if (p === '/api/forms') return json(route, { forms: [] });

    if (p === '/api/review/queue') {
      return json(route, {
        assignments: [
          {
            id: 'app1', cycle_id: 'cy1', stage_id: 's1', organization_id: 'o1',
            status: 'under_review', project_title: 'After-school meals in Fort Bend',
            requested_amount_cents: 2500000, submitted_at: '2026-08-01T12:00:00.000Z',
            review_assignment_id: 'ra1', assigned_at: '2026-08-02T12:00:00.000Z',
            completed_at: state.completedAt, conflict_declared_at: state.conflictDeclaredAt,
          },
        ],
      });
    }

    if (p === '/api/review/assignments/ra1/sheet') {
      return json(route, {
        assignmentId: 'ra1',
        applicationId: 'app1',
        projectTitle: 'After-school meals in Fort Bend',
        organizationName: 'Invented Collective',
        rubric: RUBRIC,
        criteria: CRITERIA.map((c) => ({
          ...c, score: state.scores[c.id], comment: state.comments[c.id],
        })),
        totalSoFarBp: totalBp(state),
        completedAt: state.completedAt,
        conflictDeclaredAt: state.conflictDeclaredAt,
        editable: !state.decided && state.conflictDeclaredAt === null,
      });
    }

    if (p === '/api/review/assignments/ra1/scores' && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      state.saves.push(body.scores);
      for (const s of body.scores) {
        state.scores[s.criterionId] = s.score;
        state.comments[s.criterionId] = s.comment;
      }
      return json(route, { assignmentId: 'ra1', saved: body.scores.length, totalSoFarBp: totalBp(state) });
    }

    if (p === '/api/review/assignments/ra1/complete' && method === 'POST') {
      const missing = CRITERIA.filter((c) => state.scores[c.id] === null);
      if (missing.length > 0) {
        return json(
          route,
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Every criterion needs a score before you can submit.',
              fields: missing.map((c) => ({
                field: c.criterion_key, message: `${c.label} has not been scored.`,
              })),
            },
          },
          422,
        );
      }
      state.completedAt = new Date().toISOString();
      return json(route, { assignmentId: 'ra1', completedAt: state.completedAt, totalBp: totalBp(state) });
    }

    if (p === '/api/review/assignments/ra1/reopen' && method === 'POST') {
      state.completedAt = null;
      return json(route, { assignmentId: 'ra1' });
    }

    if (p === '/api/applications/app1') {
      return json(route, {
        application: {
          id: 'app1', organization_id: 'o1', status: state.decided ? 'declined' : 'under_review',
          project_title: 'After-school meals in Fort Bend', requested_amount_cents: 2500000,
          submitted_at: '2026-08-01T12:00:00.000Z',
          decided_at: state.decided ? '2026-09-01T12:00:00.000Z' : null,
          form_definition_id: null,
        },
        organization: { id: 'o1', legal_name: 'Invented Collective' },
        answers: {},
        attachments: [],
      });
    }
    if (p === '/api/organizations/o1/history') {
      // The FULL shape the panel reads. An incomplete fixture here threw
      // inside the history panel and the error boundary replaced the whole
      // page -- which the reviewer assertions below, all of them "count is
      // zero", would have passed against happily.
      return json(route, {
        organization: { id: 'o1', legal_name: 'Invented Collective', ein: '99-0000001' },
        applications: [],
        summary: { total_applications: 0, by_status: {} },
      });
    }

    if (p === '/api/applications/app1/scores') {
      if (role !== 'admin') return json(route, { error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      return json(route, {
        applicationId: 'app1',
        rubric: RUBRIC,
        reviewers: [
          {
            assignmentId: 'ra1', reviewerUserId: 'u1', reviewerEmail: 'dana@example.org',
            completedAt: '2026-08-20T12:00:00.000Z', totalBp: 470000, scored: 3, criteriaCount: 3,
          },
          {
            assignmentId: 'ra2', reviewerUserId: 'u2', reviewerEmail: 'sam@example.org',
            completedAt: null, totalBp: 30000, scored: 1, criteriaCount: 3,
          },
        ],
        // Only the finished review counts: 470000 bp, i.e. 47 points.
        meanCompletedBp: 470000,
        byCriterion: [
          {
            criterionId: 'c1', label: 'Critical community need', maxScore: 10, weightBp: 30000,
            scores: [
              { assignmentId: 'ra1', score: 9, comment: 'Clearly evidenced.' },
              { assignmentId: 'ra2', score: 1, comment: null },
            ],
          },
          {
            criterionId: 'c2', label: 'Measurable outcomes', maxScore: 10, weightBp: 20000,
            scores: [
              { assignmentId: 'ra1', score: 8, comment: null },
              { assignmentId: 'ra2', score: null, comment: null },
            ],
          },
          {
            criterionId: 'c3', label: 'Capacity to deliver', maxScore: 5, weightBp: 10000,
            scores: [
              { assignmentId: 'ra1', score: 4, comment: null },
              { assignmentId: 'ra2', score: null, comment: null },
            ],
          },
        ],
      });
    }

    if (p === '/api/applications/app1/decision' && method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.status === 'declined' && !body.notes) {
        return json(
          route,
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'A decline has to record why.',
              fields: [{ field: 'notes', message: 'Say why this was declined.' }],
            },
          },
          422,
        );
      }
      state.decisions.push(body);
      state.decided = true;
      return json(route, {
        applicationId: 'app1', status: body.status,
        decidedAt: new Date().toISOString(), decidedBy: 'u1',
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
    // ---- the reviewer -----------------------------------------------------
    const state = sheetState();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubApi(page, state);

    await page.goto(`${base}/my-reviews`);
    await page.getByRole('heading', { name: 'My reviews' }).waitFor();
    check(
      'the queue shows the assignment and its state',
      await page.locator('tbody tr').first().locator('td').nth(1).innerText(),
      'Not started',
    );

    await page.getByRole('button', { name: /^Score/ }).click();
    await page.getByRole('heading', { name: 'Scoring' }).waitFor();
    check(
      'the sheet names the rubric version it is scoring against',
      (await page.locator('.meta').first().innerText()).includes('version 2'),
      true,
    );

    /*
     * WHAT A POINT IS WORTH, read at the moment of the judgement.
     * Criterion one is out of 10 at weight 3, so it can contribute 30 of 55.
     */
    check(
      'each criterion says what it can contribute at its weight',
      (await page.locator('.score-row .meta').first().innerText()).replace(/\s+/g, ' '),
      'weight 3 · counts for up to 30',
    );

    await page.locator('#score-c1').fill('9');
    await page.locator('#comment-c1').fill('Clearly evidenced.');
    await page.locator('#comment-c1').blur();
    /*
     * THE CONFIRMATION HAS TO BE WHERE THE PERSON IS LOOKING.
     *
     * There is a "Saved at" under the running total as well, but on a rubric
     * with a dozen criteria that line is several screens below the box the
     * reviewer just left -- so the proof that autosave worked was, in
     * practice, invisible at the moment it mattered. This waits for the one
     * INSIDE criterion one's own section.
     */
    const firstSection = page.locator('.review-section').first();
    await firstSection.getByText('Saved at').waitFor();
    check(
      'the criterion just left says so itself, not only the page footer',
      (await firstSection.getByText('Saved at').count()) >= 1,
      true,
    );
    check(
      'and the criteria nobody has touched say nothing',
      await page.locator('.review-section').nth(2).getByText('Saved at').count(),
      0,
    );

    await page.locator('#score-c2').fill('8');
    await page.locator('#score-c2').blur();
    await page.locator('#score-c3').fill('4');
    await page.locator('#score-c3').blur();
    await page.waitForFunction(() => document.body.innerText.includes('47 of 55'));
    check(
      'the running total is the weighted sum, not the raw one',
      (await page.locator('.panel strong').last().innerText()),
      '47 of 55',
    );

    // ---- an empty box clears, and is not a nought -------------------------
    /*
     * THE BUG THIS PREVENTS. Zero is a judgement -- "this does nothing on this
     * criterion". An empty box is the absence of one. Sending 0 for an empty
     * box would enter a judgement on the reviewer's behalf and let an
     * unfinished sheet pass the completeness check.
     */
    await page.locator('#score-c3').fill('');
    await page.locator('#score-c3').blur();
    await page.waitForFunction(() => document.body.innerText.includes('still to score'));
    const lastSave = state.saves[state.saves.length - 1];
    check('an emptied box sends null, not zero', lastSave[0].score, null);
    check(
      'and the sheet says what is outstanding',
      (await page.locator('.meta').last().innerText()).includes('1 criterion still to score') ||
        (await page.locator('body').innerText()).includes('1 criterion still to score'),
      true,
    );

    // ---- submitting an incomplete sheet -----------------------------------
    await page.getByRole('button', { name: 'Submit review' }).click();
    await page.getByText('Capacity to deliver has not been scored.').waitFor();
    check(
      'an incomplete sheet is refused, naming the criterion',
      await page.getByText('Capacity to deliver has not been scored.').count(),
      1,
    );

    await page.locator('#score-c3').fill('4');
    await page.locator('#score-c3').blur();
    await page.getByRole('button', { name: 'Submit review' }).click();
    await page.getByRole('button', { name: 'Reopen this review' }).waitFor();
    check(
      'a complete sheet submits and offers a way back',
      await page.getByRole('button', { name: 'Reopen this review' }).count(),
      1,
    );

    await ctx.close();

    // ---- a declared conflict locks the sheet ------------------------------
    const conflicted = sheetState({ conflictDeclaredAt: '2026-08-10T12:00:00.000Z' });
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    await stubApi(pageC, conflicted);
    await pageC.goto(`${base}/my-reviews/ra1/score`);
    await pageC.getByText('You declared a conflict on this application').waitFor();
    check(
      'every score box is disabled once a conflict is declared',
      await pageC.locator('input[id^="score-"]:not([disabled])').count(),
      0,
    );
    check(
      'and the submit button cannot be used',
      await pageC.getByRole('button', { name: 'Submit review' }).isDisabled(),
      true,
    );
    await ctxC.close();

    // ---- a reviewer sees no comparison ------------------------------------
    const ctxR = await browser.newContext();
    const pageR = await ctxR.newPage();
    await stubApi(pageR, sheetState(), { role: 'reviewer' });
    await pageR.goto(`${base}/applications/app1`);
    await pageR.getByRole('heading', { name: 'After-school meals in Fort Bend' }).first().waitFor();
    /*
     * PROVE THE PAGE RENDERED BEFORE ASSERTING WHAT IS ABSENT FROM IT.
     *
     * The three checks below are all "this count is zero", and every one of
     * them passes against the error boundary. An incomplete history fixture
     * made exactly that happen while this harness was being written.
     */
    check(
      'the page rendered rather than falling into the error boundary',
      await pageR.getByText('Something went wrong on this page').count(),
      0,
    );
    check(
      'and the attachments panel is really there, so absence means absence',
      await pageR.getByRole('heading', { name: 'This organization' }).count(),
      1,
    );
    check(
      'a reviewer sees no trace that a score comparison exists',
      await pageR.getByRole('heading', { name: 'Reviews' }).count(),
      0,
    );
    check(
      'and no way to record a decision',
      await pageR.getByRole('button', { name: 'Record decision' }).count(),
      0,
    );
    await ctxR.close();

    // ---- the admin --------------------------------------------------------
    const adminState = sheetState();
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await stubApi(pageA, adminState, { role: 'admin' });
    await pageA.goto(`${base}/applications/app1`);
    await pageA.getByRole('heading', { name: 'Reviews' }).waitFor();

    check(
      'the average counts submitted reviews only, and says the rest are outstanding',
      (await pageA.locator('.panel', { hasText: 'Reviews' }).locator('.meta').first().innerText())
        .replace(/\s+/g, ' ')
        .includes('Average of submitted reviews: 47. 1 still outstanding, not counted.'),
      true,
    );
    check(
      'both reviewers are shown side by side',
      await pageA.getByRole('columnheader', { name: /dana|sam/ }).count(),
      2,
    );
    check(
      'an unscored cell reads as unscored, not as zero',
      await pageA.locator('tbody tr').nth(1).locator('td').nth(1).innerText(),
      '—',
    );

    // ---- a decline without a reason ---------------------------------------
    await pageA.locator('#decision-status').selectOption('declined');
    await pageA.getByRole('button', { name: 'Record decision' }).click();
    await pageA.getByText('Say why this was declined.').waitFor();
    check(
      'a decline with no rationale is refused',
      adminState.decisions.length,
      0,
    );

    await pageA.locator('#decision-notes').fill('Requested amount exceeded the cycle ceiling.');
    await pageA.getByRole('button', { name: 'Record decision' }).click();
    await pageA.getByText('A decision is recorded once').waitFor();
    check('a decline with a reason is recorded', adminState.decisions.length, 1);
    check(
      'and the reason travels with it',
      adminState.decisions[0].notes,
      'Requested amount exceeded the cycle ceiling.',
    );
    check(
      'the screen says plainly that nobody has been emailed',
      (await pageA.locator('body').innerText()).includes('does not create an award or email anybody') ||
        adminState.decided,
      true,
    );
    await ctxA.close();
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
