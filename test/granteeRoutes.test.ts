import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import {
  reportState, isOutstanding, sendReportConfirmation, type ReportState,
} from '../src/lib/granteeRoutes';
import { submitReport } from '../src/lib/reportSubmit';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Session } from '../src/types';

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
  init: { method?: string; cookie?: string; body?: unknown; env?: Env } = {},
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
    init.env ?? env(),
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

  const session: Session = { userId, email, role: 'grantee', organizationId: orgId };
  return {
    orgId, awardIds, programId: p.programId, email, userId, session,
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    periodId: period!.id,
    // The APPLICATION form and its cycle. This fixture's awards are imported
    // ones with no application behind them, so a test about applications has
    // to make its own.
    cycleId: Object.values(p.cycleIds)[0]!,
    applicationFormId: p.formDefinitionIds.application!,
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
describe('the receipt', () => {
  it('sends a copy of the report back to whoever filed it', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const row = await db.prepare(
      `SELECT subject, template_key, status FROM email_messages WHERE to_email=?`,
    ).bind(g.email).first<Record<string, string>>();
    expect(row).toMatchObject({
      template_key: 'report_received',
      subject: 'We received your final report',
    });
  });

  it('keeps the report content off the message row', async () => {
    // email_messages is an operational log, read by more people than need a
    // nonprofit's narrative and spend figures.
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const row = await db.prepare(
      `SELECT subject, context_json FROM email_messages WHERE to_email=?`,
    ).bind(g.email).first<{ subject: string; context_json: string | null }>();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('summer reading');
    expect(serialized).not.toContain('18,750');
  });

  it('never lets a mail failure undo a filing', async () => {
    /*
     * The report is committed before the receipt is attempted. A grantee shown
     * a 500 after a successful filing files again.
     *
     * The break is an unusable DISPLAY_TIMEZONE, which is not a contrived
     * choice: formatInZone throws on one, it is a single misconfigured
     * variable away, and it sits inside the receipt where a naive
     * implementation would let it escape.
     */
    const g = await grantee();
    const res = await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST',
      cookie: g.cookie,
      body: { answers: ANSWERS },
      env: { ...env(), DISPLAY_TIMEZONE: 'Not/AZone' },
    });
    expect(res.status).toBe(201);

    // Nothing was sent, and the failure is in the error log rather than in
    // the grantee's face.
    const mail = await db.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE to_email=?`,
    ).bind(g.email).first<{ n: number }>();
    expect(mail!.n).toBe(0);
    const logged = await db.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE code='REPORT_CONFIRMATION_EMAIL_FAILED'`,
    ).first<{ n: number }>();
    expect(logged!.n).toBe(1);
    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM report_submissions WHERE report_period_id=?`,
    ).bind(g.periodId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('puts the whole report, and the money in dollars, in the message itself', async () => {
    // The recorded row keeps only a subject, so this reads the rendered
    // message through a stand-in transport. Without it, a receipt with an
    // empty body and an amount of "2500000" passes every other assertion.
    const g = await grantee();
    const sent: { subject: string; text: string; html: string; to: string }[] = [];
    const transport = {
      async send(msg: { subject: string; text: string; html: string; to: string }) {
        sent.push(msg);
        return { ok: true as const, providerMessageId: 'stub-1' };
      },
    };

    const out = await submitReport(db, ctxFor(g.session), g.session, g.periodId, ANSWERS);
    await sendReportConfirmation(
      env(), ctxFor(g.session), g.session, g.periodId,
      out.reportSubmissionId, out.submittedAt,
      { transport: transport as never },
    );

    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.to).toBe(g.email);
    // The read-back: everything they sent, so they hold a record without
    // signing back in.
    expect(msg.text).toContain('We ran a summer reading programme');
    expect(msg.text).toContain('412');
    expect(msg.html).toContain('summer reading');
    // Cents became dollars exactly once, at this edge.
    expect(msg.text).toContain('$25,000');
    expect(msg.text).not.toContain('2500000');
  });

  it('will not build a receipt for a report the session does not hold', async () => {
    const mine = await grantee();
    const theirs = await grantee();
    const out = await submitReport(
      db, ctxFor(theirs.session), theirs.session, theirs.periodId, ANSWERS);

    const sent: unknown[] = [];
    await sendReportConfirmation(
      env(), ctxFor(mine.session), mine.session, theirs.periodId,
      out.reportSubmissionId, out.submittedAt,
      {
        transport: {
          async send(msg: unknown) {
            sent.push(msg);
            return { ok: true as const, providerMessageId: 'stub-2' };
          },
        } as never,
      },
    );
    // Nothing rendered, nothing sent: the lookup is scoped and simply misses.
    expect(sent).toEqual([]);
  });

  it('gives a revision its own receipt, because it is a new submission', async () => {
    const g = await grantee();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    await db.prepare(`UPDATE report_periods SET status='revisions_requested' WHERE id=?`)
      .bind(g.periodId).run();
    await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST', cookie: g.cookie, body: { answers: ANSWERS },
    });
    const n = await db.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE to_email=? AND template_key='report_received'`,
    ).bind(g.email).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('the applications on the portal', () => {
  /** An application for this organization, in whatever state the test needs. */
  async function applicationFor(
    g: { orgId: string; cycleId: string; applicationFormId: string },
    opts: { status: string; title: string; decided?: boolean },
  ): Promise<string> {
    const id = newId();
    const now = nowIso();
    // A decision records WHO and WHEN together or not at all -- the schema
    // refuses a decided_at with no decided_by, which is the same rule an award
    // acceptance follows and for the same reason.
    const decider = opts.decided ? await staffUser() : null;
    await db
      .prepare(
        `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
           status, submitted_at, decided_at, decided_by, project_title, created_at, updated_at)
         SELECT ?, ?, fd.stage_id, ?, fd.id, ?, ?, ?, ?, ?, ?, ?
           FROM form_definitions fd WHERE fd.id = ?`,
      )
      .bind(
        id, g.cycleId, g.orgId, opts.status, now, opts.decided ? now : null, decider,
        opts.title, now, now, g.applicationFormId,
      )
      .run();
    return id;
  }

  /** An admin row, because decided_by is a foreign key into users. */
  async function staffUser(): Promise<string> {
    const id = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
         VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
      )
      .bind(id, `portal-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
      .run();
    return id;
  }

  /*
   * WHY THIS EXISTS. `listApplicationsForExternal` was written in Phase 1,
   * correctly scoped and correctly masked, and nothing ever called it. So
   * somebody who submitted an application and closed the tab had no page
   * anywhere that said so: the portal listed awards only, the read-back lived
   * at a URL they would have had to keep, and signing in again landed them on
   * "there are no grants on this account yet". Did it go through is the
   * commonest question an applicant has, and the product had no answer.
   */

  it('lists the organization own applications, with the program that they are for', async () => {
    const g = await grantee();
    const appId = await applicationFor(g, { status: 'submitted', title: 'Literacy Lab' });

    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{
      applications: {
        id: string; status: string; projectTitle: string | null; programName: string | null;
      }[];
    }>();
    const mine = body.applications.find((a) => a.id === appId);
    expect(mine?.status).toBe('submitted');
    expect(mine?.projectTitle).toBe('Literacy Lab');
    // The program name is fetched separately and joined in memory, because it
    // is not on the applicant column allowlist and widening that list would
    // make it mean "safe to send, plus these".
    expect(mine?.programName).toBeTruthy();
  });

  it('never shows a decision the Foundation has not delivered', async () => {
    /*
     * THE BUG THIS PREVENTS, and the reason this reads through
     * listApplicationsForExternal rather than a query written for this page.
     * `applications.status` becomes 'declined' the instant an admin records
     * the decision -- days before a human finishes the letter, and after the
     * Foundation deliberately built a human-release gate on that email so it
     * would not happen. Re-implementing the read here would be
     * re-implementing the mask, and getting it wrong is a nonprofit learning
     * it was declined from a status chip.
     */
    const g = await grantee();
    const appId = await applicationFor(g, {
      status: 'declined', title: 'Quietly declined', decided: true,
    });

    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{ applications: { id: string; status: string }[] }>();
    expect(body.applications.find((a) => a.id === appId)?.status).toBe('under_review');
    expect(JSON.stringify(body)).not.toContain('decision_communicated_at');
  });

  it('does not list another organization applications', async () => {
    const mine = await grantee();
    const theirs = await grantee();
    await applicationFor(mine, { status: 'submitted', title: 'Not yours to read' });

    const res = await call('/api/grantee/home', { cookie: theirs.cookie });
    expect(JSON.stringify(await res.json())).not.toContain('Not yours to read');
  });

  it('carries applications for an organization holding no grants at all', async () => {
    /*
     * THE EARLY-RETURN BRANCH, which is the one that matters most. It existed
     * because this page was only ever about grants, and it returned an empty
     * payload the moment an organization had no awards -- which is exactly
     * the applicant who has applied and holds nothing yet, the commonest
     * visitor to this page and the one who most needs to know their
     * application arrived.
     */
    const g = await grantee();
    const appId = await applicationFor(g, { status: 'submitted', title: 'Applied, no grant yet' });
    // Soft-delete the fixture's award, so the organization has applied and
    // holds nothing -- which is what a first-time applicant looks like.
    await db
      .prepare(`UPDATE awards SET deleted_at = ? WHERE organization_id = ?`)
      .bind(nowIso(), g.orgId)
      .run();

    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await res.json<{
      awards: unknown[]; applications: { id: string; projectTitle: string | null }[];
    }>();
    expect(body.awards).toEqual([]);
    expect(body.applications.find((a) => a.id === appId)?.projectTitle)
      .toBe('Applied, no grant yet');
  });
});

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

  it('shows the grantee what they filed, so it can be read back', async () => {
    /*
     * WHAT THIS CLOSES. A grantee could attach documents to a report and never
     * see them again -- and "did I send the right budget?" is asked most often
     * AFTER submitting, which is exactly when the page could not answer it.
     * The same gap the application form had, in the place a grantee returns
     * to most.
     */
    const g = await grantee();
    const up = await call(`/api/grantee/reports/${g.periodId}/uploads`, {
      method: 'POST', cookie: g.cookie, body: intent,
    });
    const { attachmentId } = await up.json<{ attachmentId: string }>();
    // The answer carries the filename as well as the id: the client controls
    // both and the server trusts neither, but it refuses a reference with
    // half of it missing.
    const sub = await call(`/api/grantee/reports/${g.periodId}/submit`, {
      method: 'POST',
      cookie: g.cookie,
      body: {
        answers: {
          ...ANSWERS,
          supporting_files: [{ attachment_id: attachmentId, filename: 'photos.pdf' }],
        },
      },
    });
    expect(sub.status).toBe(201);

    const home = await call('/api/grantee/home', { cookie: g.cookie });
    const body = await home.json<{
      awards: { reports: { id: string; attachments: { id: string; filename: string }[] }[] }[];
    }>();
    const report = body.awards.flatMap((a) => a.reports).find((r) => r.id === g.periodId);
    expect(report?.attachments.map((f) => f.filename)).toEqual(['photos.pdf']);
    expect(report?.attachments[0]?.id).toBe(attachmentId);
  });

  it('does not offer another organization a file back through this page', async () => {
    /*
     * WHAT THIS TEST CAN AND CANNOT PROVE, said plainly because a mutant made
     * the difference visible. The files are grouped onto the period list,
     * which is already scoped to this organization's awards -- so this passes
     * even with the organization_id clause removed from the query. It is a
     * guard against a future grouping change, not a proof of the WHERE.
     *
     * What the clause buys is that another organization's rows are never read
     * at all, which is a blast-radius argument rather than a behavioural one
     * and is stated as such in granteeRoutes.ts.
     */
    const mine = await grantee();
    const up = await call(`/api/grantee/reports/${mine.periodId}/uploads`, {
      method: 'POST', cookie: mine.cookie, body: intent,
    });
    const { attachmentId } = await up.json<{ attachmentId: string }>();
    await call(`/api/grantee/reports/${mine.periodId}/submit`, {
      method: 'POST',
      cookie: mine.cookie,
      body: {
        answers: {
          ...ANSWERS,
          supporting_files: [{ attachment_id: attachmentId, filename: 'photos.pdf' }],
        },
      },
    });

    const theirs = await grantee();
    const home = await call('/api/grantee/home', { cookie: theirs.cookie });
    expect(JSON.stringify(await home.json())).not.toContain('photos.pdf');
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

describe('the step an applicant is on', () => {
  /**
   * THE FLOW THAT WAS BROKEN, end to end at the HTTP layer.
   *
   * An Inspire Change application is two stages: a ten-question eligibility
   * screen, then the thirty-four-question form. Submitting the first produced
   * an application row, and the portal rendered it as "Grant application —
   * Received. We have it. You do not need to do anything else for now."
   *
   * Both halves of that were wrong. It is not the grant application, and the
   * full form had not been started -- nor could it be, because nothing in the
   * UI called POST /api/applications, the one endpoint that starts the next
   * stage. An applicant who passed eligibility had no route to the form they
   * were waiting to fill in.
   */
  async function twoStageOrg() {
    const g = await grantee();
    const now = nowIso();

    /*
     * INSPIRE_CHANGE ALREADY HAS BOTH STAGES, and building a second one here
     * hit the unique index on (program_id, stage_key) -- which is the schema
     * saying so. The seeded program is the realistic fixture anyway: this is
     * the shape a real applicant meets.
     */
    const stages = await db.prepare(
      `SELECT ps.id, ps.stage_key, ps.sort_order, fd.id AS form_id
         FROM program_stages ps
         JOIN form_definitions fd ON fd.stage_id = ps.id AND fd.status='published'
        WHERE ps.program_id = ? ORDER BY ps.sort_order`,
    ).bind(g.programId).all<{ id: string; stage_key: string; sort_order: number; form_id: string }>();
    expect(stages.results.length, 'the fixture needs two published stages').toBe(2);
    const [first, second] = stages.results;

    // Stage one, already submitted -- the state the eligibility screen leaves.
    const app1 = newId();
    await db.prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id,
         form_definition_id, status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?, 'submitted', ?,?,?)`,
    ).bind(app1, g.cycleId, first!.id, g.orgId, first!.form_id, now, now, now).run();

    await db.prepare(
      `UPDATE cycles SET status='open', opens_at=?, closes_at=? WHERE id=?`,
    ).bind(day('2020-01-01'), day('2099-01-01'), g.cycleId).run();

    return { ...g, app1, stage2: second!.id, form2: second!.form_id, stage2Key: second!.stage_key };
  }

  it('does not call a finished eligibility screen a finished application', async () => {
    const g = await twoStageOrg();
    const res = await call('/api/grantee/home', { cookie: g.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applications: { id: string; stageName: string | null; isFinalStage: boolean }[];
    };
    const row = body.applications.find((a) => a.id === g.app1);
    expect(row, 'the submitted stage-one application is listed').toBeTruthy();
    expect(row!.stageName).toBeTruthy();
    expect(row!.isFinalStage, 'a later published stage exists, so this is not the end').toBe(false);
  });

  it('calls it final when there is genuinely nothing after it', async () => {
    const g = await twoStageOrg();
    // Retire the second stage's form. A stage with no published form is not a
    // step anybody can take, and telling somebody otherwise is worse than
    // saying nothing.
    await db.prepare(`UPDATE form_definitions SET status='retired' WHERE id=?`)
      .bind(g.form2).run();
    const res = await call('/api/grantee/home', { cookie: g.cookie });
    const body = (await res.json()) as { applications: { id: string; isFinalStage: boolean }[] };
    expect(body.applications.find((a) => a.id === g.app1)!.isFinalStage).toBe(true);
  });

  it('starts the next stage, and it is the one the applicant has not done', async () => {
    const g = await twoStageOrg();
    const res = await call('/api/applications', {
      method: 'POST', cookie: g.cookie, body: { cycleId: g.cycleId },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application: { id: string; stage_key: string } };
    expect(body.application.stage_key).toBe(g.stage2Key);

    // And it is a real draft this organization can open and fill in.
    const draft = await call(`/api/applications/${body.application.id}/draft`, { cookie: g.cookie });
    expect(draft.status).toBe(200);
  });

  it('stops calling the step outstanding once the next one is started', async () => {
    /*
     * isFinalStage says a next step EXISTS; it does not say whether the person
     * has taken it. Without this distinction the portal kept offering
     * "Continue your application" after the application had been started, and
     * the endpoint behind that button answers 409 -- so the button was an
     * invitation to an error. Found by driving the page twice.
     */
    const g = await twoStageOrg();
    const before = (await (await call('/api/grantee/home', { cookie: g.cookie })).json()) as {
      applications: { id: string; nextStageStarted: boolean }[];
    };
    expect(before.applications.find((a) => a.id === g.app1)!.nextStageStarted).toBe(false);

    await call('/api/applications', { method: 'POST', cookie: g.cookie, body: { cycleId: g.cycleId } });

    const after = (await (await call('/api/grantee/home', { cookie: g.cookie })).json()) as {
      applications: { id: string; nextStageStarted: boolean }[];
    };
    expect(after.applications.find((a) => a.id === g.app1)!.nextStageStarted).toBe(true);
  });

  it('names the cycle each application belongs to, so continuing starts the right one', async () => {
    // The first version of the portal button passed the first OPEN cycle
    // rather than the application's own, which starts another programme's
    // first stage the moment two cycles are open. A browser drive caught it.
    const g = await twoStageOrg();
    const body = (await (await call('/api/grantee/home', { cookie: g.cookie })).json()) as {
      applications: { id: string; cycleId: string | null }[];
    };
    expect(body.applications.find((a) => a.id === g.app1)!.cycleId).toBe(g.cycleId);
  });

  it('refuses to start it twice', async () => {
    const g = await twoStageOrg();
    await call('/api/applications', { method: 'POST', cookie: g.cookie, body: { cycleId: g.cycleId } });
    const again = await call('/api/applications', {
      method: 'POST', cookie: g.cookie, body: { cycleId: g.cycleId },
    });
    expect(again.status).toBe(409);
  });
});
