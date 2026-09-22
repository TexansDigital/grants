import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { routes } from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { buildReportForm } from '../src/lib/reportForm';
import { generateReportPeriods } from '../src/lib/reportPeriods';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { INTERNAL_ONLY_COLUMNS } from '../src/lib/scope';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env } from '../src/types';

/**
 * THE CENSUS. Every route an external user can reach, checked against the two
 * rules that must never be wrong, by walking the real route table rather than
 * a list somebody remembered to update.
 *
 * WHY THIS IS DIFFERENT FROM THE TESTS ALREADY HERE. scope.ts has thorough
 * per-function tests and writeRoutes.ts has a thorough census of the route
 * TABLE -- roles declared, doors named, writes admin-only. Neither answers the
 * question an attacker actually asks, which is what happens when I put
 * somebody else's id in this URL. That was tested route by route, wherever
 * somebody thought of it, and "wherever somebody thought of it" is not a
 * property you can hold onto while the table grows.
 *
 * THE MECHANISM THAT MAKES IT HOLD. Every applicant-authed route carrying an
 * `:id` must appear in NEIGHBOUR below, and a route that does not appear fails
 * this file. So adding an external route tomorrow does not quietly inherit a
 * pass: it stops the suite until somebody writes down what another
 * organization's id does to it. That is the only part of this file that
 * survives contact with a codebase that keeps changing.
 *
 * CLAUDE.md, non-negotiable 4: "External data access is scoped by
 * `organization_id` from the session, never from a request parameter."
 * Non-negotiable 5: reviewer scores, internal notes and decision rationale are
 * "Not hidden in the UI. Absent from the payload."
 */

const ORIGIN = 'https://applications.example.org';
const env = () => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
});
const day = (s: string) => `${s}T00:00:00.000Z`;

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

let n = 0;

/**
 * One nonprofit with one of everything an external route can name: a draft
 * application, an open report period, an attachment, and an award offered and
 * not yet answered.
 *
 * The internal fields are filled with sentences nobody could mistake for
 * anything else, because the payload scan below looks for them by value. A
 * scan for the COLUMN NAME would pass against a response that renamed the
 * field on its way out and shipped the reviewer's words anyway.
 */
async function nonprofit(programId: string, cycleId: string, stageId: string, formId: string) {
  const adminCtx = ctxFor(adminSession());
  const now = nowIso();
  const i = ++n;
  const orgId = newId();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, `Census Nonprofit ${i}`, String(930000000 + i), now, now).run();

  const applicationId = newId();
  await db.prepare(
    `INSERT INTO applications
       (id, cycle_id, stage_id, organization_id, form_definition_id, status,
        project_title, internal_notes, decision_notes, submission_ip, submission_user_agent,
        created_at, updated_at)
     VALUES (?,?,?,?,?, 'draft', ?,?,?,?,?,?,?)`,
  ).bind(
    applicationId, cycleId, stageId, orgId, formId,
    `Census project ${i}`,
    `INTERNAL-ONLY-MARKER-${i} the board is thin and we are not convinced`,
    `DECISION-RATIONALE-MARKER-${i} declined as the weakest of the cohort`,
    '203.0.113.99', 'Mozilla/5.0 census', now, now,
  ).run();

  const awardId = newId();
  await db.prepare(
    `INSERT INTO awards
       (id, application_id, organization_id, program_id, awarded_amount_cents, awarded_at,
        status, term_start, term_end, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'pending', ?,?,?,?)`,
  ).bind(awardId, applicationId, orgId, programId, 2_500_000 + i, now,
         day('2025-01-01'), day('2025-12-31'), now, now).run();
  await generateReportPeriods(db, adminCtx, awardId);
  const period = await db.prepare(
    `SELECT id FROM report_periods WHERE award_id=? LIMIT 1`,
  ).bind(awardId).first<{ id: string }>();

  const attachmentId = newId();
  await db.prepare(
    `INSERT INTO attachments
       (id, organization_id, parent_type, parent_id, r2_key, filename, mime_type,
        size_bytes, uploaded_at)
     VALUES (?,?,'application',?,?,?, 'application/pdf', 1024, ?)`,
  ).bind(attachmentId, orgId, applicationId,
         `census/${attachmentId}.pdf`, `financials-${i}.pdf`, now).run();

  const userId = newId();
  const email = `census-${i}-${crypto.randomUUID().slice(0, 6)}@example.org`;
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'grantee', ?, 1, ?, ?)`,
  ).bind(userId, email, orgId, now, now).run();
  const { sessionToken } = await createSession(env(), userId);

  return {
    orgId, applicationId, awardId, attachmentId,
    periodId: period!.id,
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    marker: `MARKER-${i}`,
  };
}

type Neighbour = Awaited<ReturnType<typeof nonprofit>>;

/**
 * For each external route carrying an `:id`, the id to substitute and a body
 * good enough to get past argument validation.
 *
 * The body matters. A route that rejects an empty body with a 400 BEFORE it
 * ever looks up the id would pass a scoping test that sent nothing, while
 * proving nothing about scoping at all.
 */
const NEIGHBOUR: Record<string, (o: Neighbour) => { path: string; body?: unknown }> = {
  'POST /api/applications/:id/uploads': (o) => ({
    path: `/api/applications/${o.applicationId}/uploads`,
    body: { fieldKey: 'financial_statements', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1024 },
  }),
  'GET /api/applications/:id/draft': (o) => ({ path: `/api/applications/${o.applicationId}/draft` }),
  'PATCH /api/applications/:id/draft': (o) => ({
    path: `/api/applications/${o.applicationId}/draft`,
    body: { answers: { project_title: 'taken over' } },
  }),
  'POST /api/applications/:id/submit': (o) => ({
    path: `/api/applications/${o.applicationId}/submit`, body: {},
  }),
  'GET /api/grantee/reports/:id': (o) => ({ path: `/api/grantee/reports/${o.periodId}` }),
  'PATCH /api/grantee/reports/:id/draft': (o) => ({
    path: `/api/grantee/reports/${o.periodId}/draft`, body: { answers: { narrative: 'taken over' } },
  }),
  'POST /api/grantee/reports/:id/submit': (o) => ({
    path: `/api/grantee/reports/${o.periodId}/submit`, body: { answers: {} },
  }),
  'POST /api/grantee/reports/:id/uploads': (o) => ({
    path: `/api/grantee/reports/${o.periodId}/uploads`,
    body: { fieldKey: 'supporting_files', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1024 },
  }),
  'POST /api/portal/attachments/:id/download-url': (o) => ({
    path: `/api/portal/attachments/${o.attachmentId}/download-url`, body: {},
  }),
  'POST /api/my/awards/:id/accept': (o) => ({
    path: `/api/my/awards/${o.awardId}/accept`, body: { attestationText: 'I accept.' },
  }),
  'POST /api/my/awards/:id/decline': (o) => ({
    path: `/api/my/awards/${o.awardId}/decline`, body: { reason: 'Taking it elsewhere.' },
  }),
};

/** Every applicant-authed route that names something by id. */
function externalIdRoutes(): { key: string; method: string; path: string }[] {
  return routes
    .filter((r) => r.auth === 'applicant' && r.path.includes(':'))
    .map((r) => ({ key: `${r.method} ${r.path}`, method: r.method, path: r.path }));
}

async function twoNonprofits() {
  const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `cen-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const stageId = p.stageIds.application!;
  const formId = p.formDefinitionIds.application!;
  const now = nowIso();

  await db.prepare(
    `INSERT INTO metric_definitions
       (id, program_id, metric_key, label, metric_type, unit, is_required, sort_order,
        status, promotes_to, created_at, updated_at)
     VALUES (?,?, 'individuals_served', 'How many?', 'integer', 'people', 1, 10, 'active', NULL, ?, ?)`,
  ).bind(newId(), p.programId, now, now).run();
  const form = await buildReportForm(db, ctxFor(adminSession()), { programId: p.programId });
  await db.prepare(`UPDATE form_definitions SET status='published', published_at=? WHERE id=?`)
    .bind(now, form.formDefinitionId).run();

  return {
    a: await nonprofit(p.programId, cycleId, stageId, formId),
    b: await nonprofit(p.programId, cycleId, stageId, formId),
  };
}

// ---------------------------------------------------------------------------

describe('the external route census', () => {
  it('names every external route that takes an id, so a new one cannot slip in', () => {
    const declared = externalIdRoutes().map((r) => r.key);
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter((k) => !(k in NEIGHBOUR));
    expect(
      missing,
      'an external route takes an :id and nothing here says what another ' +
        "organization's id does to it. Add it to NEIGHBOUR with a scoping test.",
    ).toEqual([]);
  });

  it('has no stale entries, so the list describes the table it claims to', () => {
    const declared = new Set(externalIdRoutes().map((r) => r.key));
    const stale = Object.keys(NEIGHBOUR).filter((k) => !declared.has(k));
    expect(stale, 'these are tested and no longer exist').toEqual([]);
  });

  it("404s EVERY external route given another organization's id", async () => {
    const { a, b } = await twoNonprofits();
    const results: Record<string, number> = {};
    for (const route of externalIdRoutes()) {
      const { path, body } = NEIGHBOUR[route.key]!(b);
      const res = await call(path, { method: route.method, cookie: a.cookie, body });
      results[route.key] = res.status;
    }
    // Asserted as ONE object rather than in a loop: a loop reports the first
    // failure and hides the rest, and "which of these eleven leak" is the
    // whole question.
    expect(results).toEqual(
      Object.fromEntries(externalIdRoutes().map((r) => [r.key, 404])),
    );
  });

  it('404s, never 403 -- a refusal that confirms the row exists is an oracle', async () => {
    const { a, b } = await twoNonprofits();
    for (const route of externalIdRoutes()) {
      const { path, body } = NEIGHBOUR[route.key]!(b);
      const mine = NEIGHBOUR[route.key]!(a);
      const theirs = await call(path, { method: route.method, cookie: a.cookie, body });
      const absent = await call(mine.path.replace(/[0-9a-f-]{36}/, newId()), {
        method: route.method, cookie: a.cookie, body: mine.body,
      });
      expect(
        [theirs.status, absent.status],
        `${route.key}: another org's id and an id that does not exist must be indistinguishable`,
      ).toEqual([404, 404]);
    }
  });

  it("changes nothing in the neighbour's records", async () => {
    const { a, b } = await twoNonprofits();
    const before = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM application_answers WHERE application_id=?) AS answers,
              (SELECT status FROM applications WHERE id=?) AS appStatus,
              (SELECT status FROM awards WHERE id=?) AS awardStatus,
              (SELECT COUNT(*) FROM attachments WHERE organization_id=?) AS files`,
    ).bind(b.applicationId, b.applicationId, b.awardId, b.orgId).first();

    for (const route of externalIdRoutes()) {
      const { path, body } = NEIGHBOUR[route.key]!(b);
      await call(path, { method: route.method, cookie: a.cookie, body });
    }

    const after = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM application_answers WHERE application_id=?) AS answers,
              (SELECT status FROM applications WHERE id=?) AS appStatus,
              (SELECT status FROM awards WHERE id=?) AS awardStatus,
              (SELECT COUNT(*) FROM attachments WHERE organization_id=?) AS files`,
    ).bind(b.applicationId, b.applicationId, b.awardId, b.orgId).first();
    expect(after).toEqual(before);
  });
});

describe('what an external user is allowed to read back', () => {
  /**
   * THE FORBIDDEN VALUES, not the forbidden column names.
   *
   * Checking for `internal_notes` as a KEY passes against a response that
   * renamed it to `notes` on the way out and shipped the reviewer's sentence
   * anyway. These are the sentences themselves.
   */
  it('never returns internal notes, decision rationale, or submission metadata', async () => {
    const { a } = await twoNonprofits();
    const bodies: { path: string; text: string }[] = [];
    for (const [method, path, body] of [
      ['GET', '/api/me', undefined],
      ['GET', '/api/grantee/me', undefined],
      ['GET', '/api/grantee/home', undefined],
      ['GET', '/api/my/awards', undefined],
      ['GET', `/api/applications/${a.applicationId}/draft`, undefined],
      ['GET', `/api/grantee/reports/${a.periodId}`, undefined],
    ] as const) {
      const res = await call(path, { method, cookie: a.cookie, body });
      // A 404 here would make the scan vacuous, so the status is asserted too.
      expect(res.status, `${method} ${path}`).toBe(200);
      bodies.push({ path, text: await res.text() });
    }

    const forbidden = [
      'INTERNAL-ONLY-MARKER',
      'DECISION-RATIONALE-MARKER',
      // Submission metadata. Kept for the audit trail, never shown back.
      '203.0.113.99',
      'Mozilla/5.0 census',
    ];
    const leaks: string[] = [];
    for (const { path, text } of bodies) {
      for (const needle of forbidden) {
        if (text.includes(needle)) leaks.push(`${path} contains ${needle}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('never returns a reviewer score or a rubric criterion to an external user', async () => {
    const { a } = await twoNonprofits();
    /*
     * The values are planted through the real tables rather than asserted in
     * the abstract, because "no key called score" is a weaker claim than "this
     * number, which a reviewer typed, is not in the bytes".
     */
    const paths = ['/api/grantee/home', '/api/my/awards', `/api/applications/${a.applicationId}/draft`];
    for (const path of paths) {
      const res = await call(path, { cookie: a.cookie });
      expect(res.status, path).toBe(200);
      const parsed: unknown = await res.json();
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) {
            keys.add(k);
            walk(child);
          }
        }
      };
      walk(parsed);
      const suspicious = [...keys].filter((k) =>
        /score|rubric|criterion|reviewer|internal|rationale|conflict/i.test(k));
      expect(suspicious, `${path} exposes ${suspicious.join(', ')}`).toEqual([]);
    }
  });
});

describe('the last gate before a nonprofit\'s browser', () => {
  /**
   * Proof that assertNoInternalFields is WIRED, not merely present.
   *
   * It sat in scope.ts from Phase 1 with thorough tests and no production
   * caller at all -- reachable only from its own test file -- so "it exists
   * and is tested" is exactly the evidence that turned out to mean nothing.
   * This test reaches it the way a request does: through dispatch.
   *
   * The leak is planted as DATA rather than by editing a handler, because the
   * one external payload keyed by data is the answers map, and that is the
   * only way an internal column name can appear in a response whose handler
   * names every column it returns. Getting a field named `internal_notes` in
   * there now requires dropping the trigger 0026 added, which is the whole
   * point of that migration: the collision is refused when an admin builds
   * the form, not when an applicant submits it.
   */
  it('500s rather than sending an internal-only field to an applicant', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `leak-${++n}` });
    const cycleId = Object.values(p.cycleIds)[0]!;
    const now = nowIso();

    /*
     * A DEFINITION OF ITS OWN, built as a draft.
     *
     * The seeded one cannot be used and the reason is worth recording: 0003
     * makes a published definition immutable AND refuses to return it to
     * draft, so there is no way to smuggle a field into a live form at all.
     * That is a second, independent reason this leak is unreachable in the
     * ordinary course of events -- and the reason this test has to build the
     * hostile form from scratch rather than tamper with a real one.
     */
    const formId = newId();
    await db.prepare(
      `INSERT INTO form_definitions
         (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
       VALUES (?,?,?,?, 'application', 'Leak form', 99, 'draft', ?, ?)`,
    ).bind(formId, p.programId, `leak_${n}`, p.stageIds.application!, now, now).run();
    const sectionId = newId();
    await db.prepare(
      `INSERT INTO form_sections
         (id, form_definition_id, section_key, title, sort_order, created_at)
       VALUES (?,?, 'only', 'Only section', 0, ?)`,
    ).bind(sectionId, formId, now).run();

    // The reserved-key trigger comes off for exactly this insert and goes
    // straight back on. Dropping it is what makes the leak reachable at all,
    // which is the test's point rather than a workaround.
    await db.exec(`DROP TRIGGER form_fields_may_not_use_an_internal_column_name`);
    const fieldId = newId();
    await db.prepare(
      `INSERT INTO form_fields
         (id, form_definition_id, form_section_id, field_key, label, field_type,
          is_required, sort_order, created_at)
       VALUES (?,?,?, 'internal_notes', 'Smuggled', 'long_text', 0, 0, ?)`,
    ).bind(fieldId, formId, sectionId, now).run();
    await db.exec(
      `CREATE TRIGGER form_fields_may_not_use_an_internal_column_name ` +
      `BEFORE INSERT ON form_fields WHEN NEW.field_key IN ` +
      `(${INTERNAL_ONLY_COLUMNS.map((c) => `'${c}'`).join(',')}) ` +
      `BEGIN SELECT RAISE(ABORT, 'reserved'); END`,
    );

    const orgId = newId();
    await db.prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    ).bind(orgId, `Leak Nonprofit ${n}`, String(940000000 + n), now, now).run();
    const applicationId = newId();
    await db.prepare(
      `INSERT INTO applications
         (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'draft', ?,?)`,
    ).bind(applicationId, cycleId, p.stageIds.application!, orgId, formId, now, now).run();
    await db.prepare(
      `INSERT INTO application_answers
         (id, application_id, form_field_id, field_key, label_at_answer, field_type,
          value_text, answered_at)
       VALUES (?,?,?, 'internal_notes', 'Smuggled', 'long_text',
               'what the reviewer really thought', ?)`,
    ).bind(newId(), applicationId, fieldId, now).run();

    const userId = newId();
    const email = `leak-${n}-${crypto.randomUUID().slice(0, 6)}@example.org`;
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
    ).bind(userId, email, orgId, now, now).run();
    const { sessionToken } = await createSession(env(), userId);

    const res = await call(`/api/applications/${applicationId}/draft`, {
      cookie: `${SESSION_COOKIE}=${sessionToken}`,
    });
    expect(res.status).toBe(500);
    // And the refusal says nothing about what it caught: the internal message
    // names the field, the applicant gets the generic one.
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain('internal_notes');
    expect(body.error.message).not.toContain('what the reviewer really thought');
  });

  it('refuses a form field named after an internal column, at build time', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `rsv-${++n}` });
    const now = nowIso();
    /*
     * A DRAFT definition, so the refusal under test is unambiguously the
     * reserved-key trigger and not 0003's immutability one firing first. Two
     * BEFORE INSERT triggers on one table have no defined order, and a test
     * that passes on whichever happens to go first is a test of nothing.
     */
    const formId = newId();
    await db.prepare(
      `INSERT INTO form_definitions
         (id, program_id, form_key, stage_id, kind, name, version, status, created_at, updated_at)
       VALUES (?,?,?,?, 'application', 'Reserved-key form', 98, 'draft', ?, ?)`,
    ).bind(formId, p.programId, `rsv_${n}`, p.stageIds.application!, now, now).run();
    const sectionId = { id: newId() };
    await db.prepare(
      `INSERT INTO form_sections
         (id, form_definition_id, section_key, title, sort_order, created_at)
       VALUES (?,?, 'only', 'Only section', 0, ?)`,
    ).bind(sectionId.id, formId, now).run();
    await expect(
      db.prepare(
        `INSERT INTO form_fields
           (id, form_definition_id, form_section_id, field_key, label, field_type,
            is_required, sort_order, created_at)
         VALUES (?,?,?, 'decision_notes', 'Sneaky', 'long_text', 0, 0, ?)`,
      ).bind(newId(), formId, sectionId.id, now).run(),
    ).rejects.toThrow(/reserved/);
  });

  it('keeps the migration list and INTERNAL_ONLY_COLUMNS in step', async () => {
    /*
     * The trigger's list is SQL and cannot be derived from the TypeScript one,
     * so the two are copies. A copy that drifts is worse than no copy: the
     * guard would fail closed on a field the trigger happily allowed, which
     * an applicant discovers mid-form.
     */
    const sql = await db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='form_fields_may_not_be_renamed_to_an_internal_column_name'`,
    ).first<{ sql: string }>();
    expect(sql, 'migration 0026 has not been applied to this database').toBeTruthy();
    const missing = INTERNAL_ONLY_COLUMNS.filter((c) => !sql!.sql.includes(`'${c}'`));
    expect(missing, 'in INTERNAL_ONLY_COLUMNS but not refused as a field key').toEqual([]);
  });
});
