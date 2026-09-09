import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession, applicantSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { confirmationCode, sendConfirmation } from '../src/lib/applicantRoutes';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Session } from '../src/types';

const ORIGIN = 'https://applications.example.org';
const envFor = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  ...over,
});

let n = 0;

/** A complete, valid submission for the seeded Inspire Change form. */
function payload(atts: { fin: string; op: string }, over: Record<string, unknown> = {}) {
  return {
    entity_type_confirmation: true,
    guidelines_attestation: true,
    authorization_attestation: true,
    contact_first_name: 'Alex',
    contact_last_name: 'Moreno',
    contact_email: 'Grants@Example-BayouReach.org',
    contact_phone: '(713) 555-0123',
    contact_job_title: 'Executive Director',
    organization_name: 'Bayou Reach Collective',
    ein: '00-1234567',
    organization_address: {
      address_1: '100 Example Street', city: 'Houston', state: 'tx', postal_code: '77002', country: 'US',
    },
    mission_statement: 'Expanding after-school literacy programs in under-resourced neighborhoods.',
    annual_operating_budget: '$825,000',
    project_title: 'Literacy Lab',
    requested_amount: '$25,000.07',
    funding_type: 'programs',
    area_of_focus: 'education',
    counties_served: ['harris', 'fort_bend'],
    advancing_opportunity: 'We serve students in neighborhoods with limited access to tutoring.',
    project_summary: 'Reading intervention paired with mentoring for 400 students each year.',
    community_need: 'Reading proficiency in our service area trails the state average considerably.',
    implementation_timeline: 'Hire in August, launch in September, evaluate each quarter.',
    individuals_benefiting: 'Approximately 400 students, largely Black and Latino, grades 3 to 8.',
    estimated_individuals_count: '400',
    leadership_lived_experience: 'Our board includes parents and alumni of the program.',
    partial_funding_plan: 'We would reduce the number of sites from four to two.',
    volunteer_engagement: 'Reading buddy sessions and a back-to-school supply drive.',
    itemized_budget: 'Tutors $12,000. Materials $5,000. Evaluation $8,007.',
    financial_statements: [{ attachment_id: atts.fin, filename: 'audit-2025.pdf' }],
    operating_budget_doc: [{ attachment_id: atts.op, filename: 'operating.xlsx' }],
    marketing_opt_in: true,
    ...over,
  };
}

async function setup() {
  const adminCtx = ctxFor(adminSession());
  const program = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `sr-${++n}` });
  const org = await seedOrganization(db, adminCtx, {
    ...ORG_FIXTURES[0]!,
    ein: String(600000000 + n),
    legalName: `${ORG_FIXTURES[0]!.legalName} ${n}`,
    // The signed-in user. Deliberately NOT the address the form names as the
    // contact, so "which one gets the receipt" is an assertion rather than a
    // coincidence.
    email: `director-${n}@example-bayoureach.org`,
  });

  const cycleId = Object.values(program.cycleIds)[0]!;
  await db
    .prepare(
      `UPDATE cycles SET opens_at='2020-01-01T00:00:00.000Z', closes_at='2099-01-01T00:00:00.000Z',
              decision_due_at='2099-03-15T17:00:00.000Z', status='open' WHERE id = ?`,
    )
    .bind(cycleId).run();

  const applicationId = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
       status, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?)`,
  ).bind(applicationId, cycleId, program.stageIds.application!, org.organizationId,
         program.formDefinitionIds.application!, now, now).run();

  const atts = { fin: newId(), op: newId() };
  for (const [key, id] of Object.entries(atts)) {
    await db.prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, 'application', null, org.organizationId, `r2/${id}`, `${key}.pdf`,
           'application/pdf', 1024, now).run();
  }

  const session: Session = applicantSession(org.organizationId, org.userId);
  const { sessionToken } = await createSession(envFor(), org.userId);
  return { program, org, cycleId, applicationId, atts, session,
           cookie: `${SESSION_COOKIE}=${sessionToken}` };
}

const post = (
  applicationId: string,
  body: unknown,
  cookie?: string,
  env: Env = envFor(),
) =>
  worker.fetch(
    new Request(`${ORIGIN}/api/applications/${applicationId}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.44',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );

beforeEach(async () => {
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('POST /api/applications/:id/submit', () => {
  it('submits, and says so in a way the applicant can quote back', async () => {
    const s = await setup();
    const res = await post(s.applicationId, { answers: payload(s.atts), guidelinesVersion: '2026.1' }, s.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applicationId: string;
      submittedAt: string;
      confirmationCode: string;
      submittedAtDisplay: string;
    };
    expect(body.applicationId).toBe(s.applicationId);
    // The screen and the confirmation email must agree about when this
    // happened, so both are formatted server-side in the program's zone. A
    // time with no zone name on it is the bug this is guarding.
    expect(body.submittedAtDisplay).toMatch(/\b(CST|CDT)\b/);
    expect(body.submittedAtDisplay).not.toBe(body.submittedAt);
    expect(body.confirmationCode).toBe(confirmationCode(s.applicationId));
    expect(body.confirmationCode).toMatch(/^IC-[0-9A-F]{4}-[0-9A-F]{4}$/);

    const app = await db.prepare(
      `SELECT status, submitted_at, requested_amount_cents, guidelines_version FROM applications WHERE id = ?`,
    ).bind(s.applicationId).first<Record<string, unknown>>();
    expect(app!.status).toBe('submitted');
    expect(app!.guidelines_version).toBe('2026.1');
    // Integer cents all the way to the row. $25,000.07.
    expect(app!.requested_amount_cents).toBe(2_500_007);
  });

  it('claims the uploaded attachments onto the application', async () => {
    const s = await setup();
    expect((await post(s.applicationId, { answers: payload(s.atts) }, s.cookie)).status).toBe(200);
    for (const id of Object.values(s.atts)) {
      const row = await db.prepare(`SELECT parent_id, parent_type FROM attachments WHERE id = ?`)
        .bind(id).first<{ parent_id: string; parent_type: string }>();
      expect(row!.parent_id).toBe(s.applicationId);
      expect(row!.parent_type).toBe('application');
    }
  });

  it('returns field errors an applicant can act on, and stays a draft', async () => {
    const s = await setup();
    const res = await post(
      s.applicationId,
      { answers: payload(s.atts, { project_summary: '', requested_amount: '' }) },
      s.cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; fields?: { field: string; message: string }[] };
    };
    // Anchored by field_key, so the review screen can scroll to the input.
    const fields = (body.error.fields ?? []).map((f) => f.field);
    expect(fields).toContain('project_summary');
    expect(fields).toContain('requested_amount');
    // In language an applicant can act on, not a code.
    for (const f of body.error.fields ?? []) {
      expect(f.message.length, f.field).toBeGreaterThan(10);
      expect(f.message).not.toMatch(/undefined|null|\[object/);
    }

    const app = await db.prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(s.applicationId).first<{ status: string }>();
    expect(app!.status).toBe('draft');
  });

  it('refuses without a session, and 404s another organization’s application', async () => {
    const mine = await setup();
    const theirs = await setup();
    expect((await post(mine.applicationId, { answers: payload(mine.atts) })).status).toBe(401);
    // 404, not 403: a 403 confirms the other application exists.
    const res = await post(theirs.applicationId, { answers: payload(theirs.atts) }, mine.cookie);
    expect(res.status).toBe(404);
    const still = await db.prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(theirs.applicationId).first<{ status: string }>();
    expect(still!.status).toBe('draft');
  });

  it('refuses a second submit of the same application', async () => {
    const s = await setup();
    expect((await post(s.applicationId, { answers: payload(s.atts) }, s.cookie)).status).toBe(200);
    const again = await post(s.applicationId, { answers: payload(s.atts) }, s.cookie);
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('the confirmation the applicant keeps', () => {
  const messageFor = (applicationId: string) =>
    db.prepare(
      `SELECT template_key, to_email, status, idempotency_key
         FROM email_messages WHERE idempotency_key = ?`,
    ).bind(`application_received:${applicationId}`).first<Record<string, unknown>>();

  it('is recorded once, addressed to the contact ON the form', async () => {
    const s = await setup();
    await post(s.applicationId, { answers: payload(s.atts) }, s.cookie);
    const msg = await messageFor(s.applicationId);
    expect(msg).not.toBeNull();
    expect(msg!.template_key).toBe('application_received');
    // Not the sign-in address: a director who names grants@ as the contact
    // expects grants@ to hold the record. Lowercased by the email coercion.
    expect(msg!.to_email).toBe('grants@example-bayoureach.org');
    // No RESEND_API_KEY in preview or tests, so nothing leaves the building.
    expect(msg!.status).toBe('suppressed');
  });

  it('does not store the applicant’s answers on the message row', async () => {
    // email_messages is an operational log, read by more people than need an
    // organization's mission statement and budget.
    const s = await setup();
    await post(s.applicationId, { answers: payload(s.atts) }, s.cookie);
    const row = await db.prepare(
      `SELECT * FROM email_messages WHERE idempotency_key = ?`,
    ).bind(`application_received:${s.applicationId}`).first<Record<string, unknown>>();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('Literacy Lab');
    expect(dump).not.toContain('825,000');
    expect(dump).not.toContain('Expanding after-school literacy');
  });

  it('still submits when the confirmation cannot be built', async () => {
    // A mail step that throws must not turn a submitted application into a 500
    // that makes an applicant submit again. An invalid display timezone makes
    // formatInZone throw inside the confirmation, which is as close to a real
    // mid-render failure as this can get without a fake provider.
    const s = await setup();
    const res = await post(
      s.applicationId,
      { answers: payload(s.atts) },
      s.cookie,
      envFor({ DISPLAY_TIMEZONE: 'Not/AZone' }),
    );
    expect(res.status).toBe(200);
    const app = await db.prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(s.applicationId).first<{ status: string }>();
    expect(app!.status).toBe('submitted');
    // And the failure is on the record rather than silent.
    const logged = await db.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE code = 'CONFIRMATION_EMAIL_FAILED'`,
    ).first<{ n: number }>();
    expect(logged!.n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('the confirmation is scoped too', () => {
  it('mails nothing when the application is not the session’s organization', async () => {
    // Unreachable through the route today, because submitApplication has
    // already refused a cross-organization id by this point. The guard is
    // asserted anyway: it is the second half of "every query touching
    // external-user data is scoped by the session", and an untested redundant
    // scope is one somebody deletes as noise.
    const mine = await setup();
    const theirs = await setup();
    await sendConfirmation(
      envFor(), ctxFor(mine.session), mine.session, theirs.applicationId, nowIso(),
    );
    const msg = await db.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key = ?`,
    ).bind(`application_received:${theirs.applicationId}`).first<{ n: number }>();
    expect(msg!.n).toBe(0);
  });

  it('mails the receipt for an application that IS the session’s', async () => {
    // The control: without this, the test above passes for a function that
    // never sends anything at all.
    const mine = await setup();
    await sendConfirmation(
      envFor(), ctxFor(mine.session), mine.session, mine.applicationId, nowIso(),
    );
    const msg = await db.prepare(
      `SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key = ?`,
    ).bind(`application_received:${mine.applicationId}`).first<{ n: number }>();
    expect(msg!.n).toBe(1);
  });
});
