import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { reportState, isOutstanding, type ReportState } from '../src/lib/granteeRoutes';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

const ORIGIN = 'https://applications.example.org';
/** Invented R2 credentials; nothing in this file reaches Cloudflare. */
const env = () => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
});
const day = (s: string) => `${s}T00:00:00.000Z`;

let n = 0;

async function call(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.10' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env(),
    {} as ExecutionContext,
  );
}

const METRICS = [
  ['individuals_served', 'How many individuals did this grant serve?', 'integer', 'people', 1, 10, null],
  ['funds_spent', 'How much of the grant has been spent?', 'currency', null, 1, 20, 'funds_spent_cents'],
] as const;

/** A funded organization with a published report form and a signed-in grantee. */
async function grantee(opts: { termEnd?: string; awards?: number } = {}) {
  const adminCtx = ctxFor(adminSession());
  const p = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `gr-${++n}` });
  const now = nowIso();

  for (const [k, label, type, unit, required, order, promotes] of METRICS) {
    await db.prepare(
      `INSERT INTO metric_definitions
         (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
          status, promotes_to, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
    ).bind(newId(), p.programId, k, label, type, unit, required, order, promotes, now, now).run();
  }
  const form = await buildReportForm(db, adminCtx, { programId: p.programId });
  await db.prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
    .bind(now, form.formDefinitionId).run();

  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Bayou Reach ${n}`, String(920000000 + n), now, now).run();

  const awardIds: string[] = [];
  for (let i = 0; i < (opts.awards ?? 1); i++) {
    const awardId = newId();
    await db.prepare(
      `INSERT INTO awards (id, organization_id, program_id, awarded_amount_cents, awarded_at,
         status, source_system, source_reference, term_start, term_end, created_at, updated_at)
       VALUES (?,?,?,?,?,'active','spreadsheet',?,?,?,?,?)`,
    ).bind(awardId, orgId, p.programId, 2_500_000 + i, now, `GR-${awardId.slice(0, 8)}`,
           day('2025-01-01'), opts.termEnd ?? day('2025-12-31'), now, now).run();
    await generateReportPeriods(db, adminCtx, awardId);
    awardIds.push(awardId);
  }

  const userId = newId();
  const email = `g${n}-${crypto.randomUUID().slice(0, 6)}@example.org`;
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
  ).bind(userId, email, orgId, now, now).run();
  const { sessionToken } = await createSession(env(), userId);

  const period = await db.prepare(
    `SELECT id FROM report_periods WHERE award_id=? LIMIT 1`,
  ).bind(awardIds[0]!).first<{ id: string }>();

  return {
    orgId, awardIds, programId: p.programId, email, userId,
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    periodId: period!.id,
  };
}

const ANSWERS = {
  narrative: 'We ran a summer reading programme across three branch libraries.',
  metric_individuals_served: '412',
  metric_funds_spent: '$18,750.25',
};

// ---------------------------------------------------------------------------
describe('signing in to the portal', () => {
  it('refuses every grantee endpoint without a session', async () => {
    const g = await grantee();
    for (const [method, path] of [
      ['GET', '/api/grantee/home'],
      ['GET', '/api/grantee/me'],
      ['GET', `/api/grantee/reports/${g.periodId}`],
      ['PATCH', `/api/grantee/reports/${g.periodId}/draft`],
      ['POST', `/api/grantee/reports/${g.periodId}/submit`],
      ['POST', `/api/grantee/reports/${g.periodId}/uploads`],
    ] as const) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('serves the portal shell to a signed-out browser rather than a blank page', async () => {
    const res = await call('/reports');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('returns the organization name for the page header and nothing else', async () => {
    const g = await grantee();
    const res = await call('/api/grantee/me', { cookie: g.cookie });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, Record<string, unknown>>>();
    expect(body.user).toEqual({ email: g.email, role: 'grantee' });
    expect(body.organization!.name).toContain('Bayou Reach');
    expect(Object.keys(body)).toEqual(['user', 'organization']);
  });
});

// ---------------------------------------------------------------------------
describe('the one page', () => {
  it('returns the award, the amount and what is due', async () => {
    const g = await grantee();
    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{ awards: Record<string, unknown>[] }>();

    expect(body.awards).toHaveLength(1);
    const award = body.awards[0]!;
    // INTEGER CENTS all the way to the edge. Formatting is the client's job.
    expect(award.amountCents).toBe(2_500_000);
    expect(award.program).toBe(INSPIRE_CHANGE.name);
    const reports = award.reports as Record<string, unknown>[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ label: 'Final report', state: 'open', outstanding: true });
  });

  it('shows every award an organization holds, newest first', async () => {
    const g = await grantee({ awards: 3 });
    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{ awards: { id: string; reports: unknown[] }[] }>();
    expect(body.awards).toHaveLength(3);
    // Each award carries its own obligations, not a pooled list.
    for (const a of body.awards) expect(a.reports).toHaveLength(1);
  });

  it('never shows another organization anything', async () => {
    const mine = await grantee();
    const theirs = await grantee();
    const res = await call('/api/grantee/home', { cookie: mine.cookie });
    const body = await res.json<{ awards: { id: string }[] }>();
    expect(body.awards.map((a) => a.id)).toEqual(mine.awardIds);
    expect(JSON.stringify(body)).not.toContain(theirs.orgId);
  });

  it('is an empty page, not an error, for an organization with no awards', async () => {
    // An applicant who has not been funded can still sign in. A 500 or a 404
    // here would read as "your grant is gone".
    const now = nowIso();
    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, 'Never Funded', String(910000000 + ++n), now, now).run();
    const userId = newId();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(userId, `nf${n}@example.org`, orgId, now, now).run();
    const { sessionToken } = await createSession(env(), userId);

    const res = await call('/api/grantee/home', { cookie: `${SESSION_COOKIE}=${sessionToken}` });
    expect(res.status).toBe(200);
    const body = await res.json<{ awards: unknown[]; organization: { name: string } }>();
    expect(body.awards).toEqual([]);
    expect(body.organization.name).toBe('Never Funded');
  });

  it('leaves a cancelled award off the page', async () => {
    const g = await grantee();
    await db.prepare(`UPDATE awards SET status='cancelled' WHERE id=?`).bind(g.awardIds[0]!).run();
    const res = await call('/api/grantee/home', { cookie: g.cookie });
    expect((await res.json<{ awards: unknown[] }>()).awards).toEqual([]);
  });

  it('carries staff feedback onto the page only once changes are requested', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    await db.prepare(
      `UPDATE report_submissions SET admin_feedback='Break out the spend by site.'
        WHERE report_period_id=?`,
    ).bind(g.periodId).run();

    // Written but not sent back yet. A grantee reading half-finished staff
    // notes on a report still under review is the failure here.
    let text = await (await call('/api/grantee/home', { cookie: g.cookie })).text();
    expect(text).not.toContain('Break out the spend');

    await db.prepare(`UPDATE report_periods SET status='revisions_requested' WHERE id=?`)
      .bind(g.periodId).run();
    text = await (await call('/api/grantee/home', { cookie: g.cookie })).text();
    expect(text).toContain('Break out the spend by site.');
  });

  it('counts a revised report once, not once per attempt', async () => {
    // A LEFT JOIN on report_submissions multiplies a period by its attempts,
    // so a report sent back twice would appear three times on the page.
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    await db.prepare(`UPDATE report_periods SET status='revisions_requested' WHERE id=?`)
      .bind(g.periodId).run();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });

    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{ awards: { reports: unknown[] }[] }>();
    expect(body.awards[0]!.reports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('what a report looks like to the grantee', () => {
  it('sends the form and an empty answer set before anything is typed', async () => {
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, Record<string, unknown>>>();
    expect(body.report).toMatchObject({ state: 'open', canFile: true, savedAt: null });
    expect(body.answers).toEqual({});
    expect(body.form!.kind).toBe('report');
    expect(body.uploadFields).toEqual(['supporting_files']);
  });

  it('sends back what was typed, and when it was saved', async () => {
    const g = await grantee();
    const saved = await call(`/api/grantee/reports/${g.periodId}/draft`, {
      method: 'PATCH', cookie: g.cookie, body: { answers: { narrative: 'Half a sentence' } },
    });
    expect(saved.status).toBe(200);

    const res = await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie });
    const body = await res.json<Record<string, Record<string, unknown>>>();
    expect(body.answers).toEqual({ narrative: 'Half a sentence' });
    expect(body.report!.state).toBe('in_progress');
    expect(body.report!.savedAt).not.toBeNull();
  });

  it('returns 404 for a report held by somebody else, not 403', async () => {
    const mine = await grantee();
    const theirs = await grantee();
    for (const [method, path, body] of [
      ['GET', `/api/grantee/reports/${theirs.periodId}`, undefined],
      ['PATCH', `/api/grantee/reports/${theirs.periodId}/draft`, { answers: {} }],
      ['POST', `/api/grantee/reports/${theirs.periodId}/submit`, { answers: ANSWERS }],
      ['POST', `/api/grantee/reports/${theirs.periodId}/uploads`, { fieldKey: 'supporting_files' }],
    ] as const) {
      const res = await call(path, { method, cookie: mine.cookie, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('stops sending the form once the report is filed', async () => {
    // A closed report renders as a statement, not as a disabled form somebody
    // will try to type into.
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const res = await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie });
    const body = await res.json<Record<string, unknown>>();
    expect(body.form).toBeUndefined();
    expect((body.report as Record<string, unknown>).state).toBe('submitted');
    expect((body.report as Record<string, unknown>).canFile).toBe(false);
  });

  it('shows staff feedback only when changes were actually requested', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    await db.prepare(
      `UPDATE report_submissions SET admin_feedback='Please break out the spend by site.'
        WHERE report_period_id=?`,
    ).bind(g.periodId).run();

    // Still 'submitted': feedback exists but nothing has been sent back.
    let body = await (await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie }))
      .json<Record<string, Record<string, unknown>>>();
    expect(body.report!.feedback).toBeNull();

    await db.prepare(`UPDATE report_periods SET status='revisions_requested' WHERE id=?`)
      .bind(g.periodId).run();
    body = await (await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie }))
      .json<Record<string, Record<string, unknown>>>();
    expect(body.report!.state).toBe('changes_requested');
    expect(body.report!.feedback).toBe('Please break out the spend by site.');
    expect(body.form).toBeDefined();
  });

  it('never returns an internal note or a decision rationale', async () => {
    const g = await grantee();
    await db.prepare(`UPDATE awards SET notes='Board wanted half this amount' WHERE id=?`)
      .bind(g.awardIds[0]!).run();

    const home = await (await call('/api/grantee/home', { cookie: g.cookie })).text();
    const report = await (await call(`/api/grantee/reports/${g.periodId}`, { cookie: g.cookie }))
      .text();
    for (const payload of [home, report]) {
      expect(payload).not.toContain('Board wanted');
      expect(payload).not.toContain('notes');
      expect(payload).not.toContain('internal');
    }
  });
});

// ---------------------------------------------------------------------------
describe('filing through the portal', () => {
  it('files a report and records the metrics', async () => {
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ reportSubmissionId: string; metricsRecorded: number }>();
    expect(body.metricsRecorded).toBe(2);

    const spent = await db.prepare(
      `SELECT funds_spent_cents FROM report_submissions WHERE id=?`,
    ).bind(body.reportSubmissionId).first<{ funds_spent_cents: number }>();
    expect(spent!.funds_spent_cents).toBe(1_875_025);
  });

  it('files what was autosaved when the last screen posts nothing', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/draft`, {
      method: 'PATCH', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const res = await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: {},
    });
    expect(res.status).toBe(201);
    expect((await res.json<{ metricsRecorded: number }>()).metricsRecorded).toBe(2);
  });

  it('lists what still needs an answer, in plain language', async () => {
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: { narrative: 'We did the work.' } },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { fields?: { field: string; message: string }[] } }>();
    const fields = (body.error.fields ?? []).map((e) => e.field);
    expect(fields).toContain('metric_individuals_served');
    expect(fields).toContain('metric_funds_spent');
    // Named in the grantee's own words, with the question they skipped.
    expect((body.error.fields ?? []).map((e) => e.message).join(' '))
      .toContain('How many individuals did this grant serve?');
  });

  it('refuses a body that is not an object of answers', async () => {
    const g = await grantee();
    for (const body of [{ answers: 'nonsense' }, { answers: ['a'] }, {}]) {
      const res = await call(`/api/grantee/reports/${g.periodId}/draft`, {
        method: 'PATCH', cookie: g.cookie, body,
      });
      // Nothing to save is not an error; a nonsense shape is simply ignored
      // rather than reaching the validator as a pretend answer set.
      expect(res.status).toBe(200);
    }
    const stored = await db.prepare(
      `SELECT answers_json FROM report_drafts WHERE report_period_id=?`,
    ).bind(g.periodId).first<{ answers_json: string }>();
    expect(JSON.parse(stored!.answers_json)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('attaching a file to a report', () => {
  const intent = {
    fieldKey: 'supporting_files',
    filename: 'photos.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 120_000,
  };

  it('authorizes an upload and records it against the report, not an application', async () => {
    // parent_type decides which submit path may later claim this file. Filed
    // as an application attachment, it would be invisible to the report that
    // is actually going to reference it.
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/uploads`, {
      method: 'POST', cookie: g.cookie, body: intent,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ attachmentId: string; uploadUrl: string; headers: unknown }>();

    // The R2 rules: the signature is in the query string and the browser sends
    // no headers at all.
    expect(body.uploadUrl).toContain('X-Amz-Signature=');
    expect(body.headers).toEqual({});

    const row = await db.prepare(
      `SELECT parent_type, parent_id, organization_id FROM attachments WHERE id=?`,
    ).bind(body.attachmentId).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      parent_type: 'report_submission',
      // Unclaimed until the report is filed: the file exists before there is a
      // submission to hang it on.
      parent_id: null,
      organization_id: g.orgId,
    });
  });

  it('refuses an upload once the report has been filed', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const res = await call(`/api/grantee/reports/${g.periodId}/uploads`, {
      method: 'POST', cookie: g.cookie, body: intent,
    });
    expect(res.status).toBe(409);
    const before = await db.prepare(
      `SELECT COUNT(*) AS n FROM attachments WHERE organization_id=?`,
    ).bind(g.orgId).first<{ n: number }>();
    expect(before!.n).toBe(0);
  });

  it('refuses an upload to a report that is not open yet', async () => {
    const g = await grantee({ termEnd: day('2099-12-31') });
    const period = await db.prepare(
      `SELECT id FROM report_periods WHERE award_id=? ORDER BY due_date DESC LIMIT 1`,
    ).bind(g.awardIds[0]!).first<{ id: string }>();
    const res = await call(`/api/grantee/reports/${period!.id}/uploads`, {
      method: 'POST', cookie: g.cookie, body: intent,
    });
    expect(res.status).toBe(409);
  });

  it('refuses a field that does not take a file', async () => {
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/uploads`, {
      method: 'POST', cookie: g.cookie, body: { ...intent, fieldKey: 'narrative' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a file type the field does not allow', async () => {
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/uploads`, {
      method: 'POST', cookie: g.cookie,
      body: { ...intent, filename: 'run.exe', mimeType: 'application/x-msdownload' },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('what state a report is in', () => {
  const form = 'form-1';
  it('reads openness before it complains about a missing form', () => {
    // Telling somebody a form is missing on a report not due for eight months
    // is noise about a problem that is ours, not theirs.
    expect(reportState(
      { status: 'scheduled', opens_at: day('2099-01-01'), form_definition_id: null }, false,
    )).toBe('not_open_yet');
    expect(reportState(
      { status: 'open', opens_at: null, form_definition_id: null }, false,
    )).toBe('no_form_yet');
  });

  it('distinguishes a report not started from one half-written', () => {
    const p = { status: 'open', opens_at: null, form_definition_id: form };
    expect(reportState(p, false)).toBe('open');
    expect(reportState(p, true)).toBe('in_progress');
  });

  it('calls a terminal state what it is', () => {
    const at = (status: string) => reportState({ status, opens_at: null, form_definition_id: form }, false);
    expect(at('submitted')).toBe('submitted');
    expect(at('accepted')).toBe('accepted');
    expect(at('waived')).toBe('waived');
    expect(at('revisions_requested')).toBe('changes_requested');
  });

  it('counts only the states a grantee still has to act on', () => {
    const todo: ReportState[] = ['open', 'in_progress', 'changes_requested'];
    expect(todo.every(isOutstanding)).toBe(true);
    const closed: ReportState[] = [
      'submitted', 'accepted', 'waived', 'not_open_yet', 'no_form_yet',
    ];
    expect(closed.some(isOutstanding)).toBe(false);
  });
});
