import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, applicantSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { saveDraft, submitApplication } from '../src/lib/submit';
import { searchApplications, toFtsQuery } from '../src/lib/search';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Session } from '../src/types';

/**
 * A complete, valid Inspire Change submission.
 *
 * `atts` are REAL attachment ids owned by the submitting organization. The
 * submit path resolves every claimed attachment against attachments that org
 * owns, so invented ids are rejected -- which is the point.
 */
function fullPayload(
  atts: { budget: string; fin: string; op: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entity_type_confirmation: true,
    guidelines_attestation: true,
    authorization_attestation: true,
    salutation: 'ms',
    contact_first_name: 'Alex',
    contact_last_name: 'Moreno',
    contact_email: 'Director@Example-BayouReach.org',
    contact_phone: '(713) 555-0123',
    contact_job_title: 'Executive Director',
    organization_name: 'Bayou Reach Collective',
    ein: '00-1234567',
    organization_website: 'example-bayoureach.org',
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
    project_summary: 'Youth mental health support paired with reading intervention for 400 students.',
    community_need: 'Reading proficiency in our service area trails the state average considerably.',
    implementation_timeline: 'Hire in August, launch in September, evaluate each quarter.',
    individuals_benefiting: 'Approximately 400 students, largely Black and Latino, grades 3 through 8.',
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

async function setup(cycleOverride: { opensAt?: string; closesAt?: string } = {}) {
  const adminCtx = ctxFor(adminSession());
  const program = await seedProgram(db, adminCtx, INSPIRE_CHANGE);
  const org = await seedOrganization(db, adminCtx, ORG_FIXTURES[0]!);

  const cycleId = Object.values(program.cycleIds)[0]!;
  // Move the cycle so "now" is inside the window.
  await db
    .prepare(`UPDATE cycles SET opens_at = ?, closes_at = ?, status='open' WHERE id = ?`)
    .bind(
      cycleOverride.opensAt ?? '2020-01-01T00:00:00.000Z',
      cycleOverride.closesAt ?? '2099-01-01T00:00:00.000Z',
      cycleId,
    )
    .run();

  const applicationId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,?)`,
    )
    .bind(applicationId, cycleId, program.stageIds.application!, org.organizationId, program.formDefinitionIds.application!, now, now)
    .run();

  // Uploads that genuinely belong to this organization.
  const atts = { budget: newId(), fin: newId(), op: newId() };
  for (const [key, id] of Object.entries(atts)) {
    await db
      .prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
             filename, mime_type, size_bytes, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(id, 'application', null, org.organizationId, `r2/${id}`, `${key}.pdf`,
            'application/pdf', 1024, now)
      .run();
  }

  const session: Session = applicantSession(org.organizationId, org.userId);
  return { program, org, cycleId, applicationId, atts, session, ctx: ctxFor(session) };
}

describe('submit', () => {
  it('writes the application, answers, promotion, search index, and audit row', async () => {
    const s = await setup();
    const result = await submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts), {
      guidelinesVersion: '2026.1',
    });
    expect(result.applicationId).toBe(s.applicationId);

    const app = await db
      .prepare(`SELECT * FROM applications WHERE id = ?`)
      .bind(s.applicationId)
      .first<Record<string, any>>();

    expect(app!.status).toBe('submitted');
    expect(app!.submitted_at).toBeTruthy();
    expect(app!.guidelines_version).toBe('2026.1');

    // Promotion, including integer-cents and EIN normalization.
    expect(app!.requested_amount_cents).toBe(2_500_007);
    expect(Number.isInteger(app!.requested_amount_cents)).toBe(true);
    expect(app!.ein_at_submit).toBe('001234567'); // dash stripped
    expect(app!.organization_name_at_submit).toBe('Bayou Reach Collective');
    expect(app!.primary_contact_email).toBe('director@example-bayoureach.org'); // lowercased
    expect(JSON.parse(app!.counties_served_json)).toEqual(['fort_bend', 'harris']);
    expect(app!.project_title).toBe('Literacy Lab');

    // Submission metadata captured natively.
    expect(app!.submission_ip).toBe('203.0.113.10');
    expect(app!.submission_user_agent).toBe('vitest');

    // Audit row exists and describes the transition.
    const audit = await db
      .prepare(`SELECT * FROM audit_log WHERE entity_id = ? AND action='application.submitted'`)
      .bind(s.applicationId)
      .first<Record<string, any>>();
    expect(audit).toBeTruthy();
    expect(audit!.actor_user_id).toBe(s.session.userId);
    expect(audit!.request_id).toBe(s.ctx.requestId);
    expect(JSON.parse(audit!.before_json).status).toBe('draft');
    expect(JSON.parse(audit!.after_json).status).toBe('submitted');
    expect(JSON.parse(audit!.changed_fields_json)).toContain('requested_amount_cents');

    // The audit snapshot does NOT duplicate submission IP / user agent.
    expect(audit!.after_json).not.toContain('203.0.113.10');
  });

  it('stores currency in value_int and never in value_real', async () => {
    const s = await setup();
    await submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts));
    const rows = await db
      .prepare(
        `SELECT field_key, field_type, value_int, value_real, typeof(value_int) AS t
           FROM application_answers
          WHERE application_id = ? AND field_type IN ('currency','integer')`,
      )
      .bind(s.applicationId)
      .all<{ field_key: string; value_int: number; value_real: number | null; t: string }>();

    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      expect(r.value_real, r.field_key).toBeNull();
      expect(r.t, r.field_key).toBe('integer');
    }
  });

  it('indexes the application for full-text search', async () => {
    const s = await setup();
    await submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts));

    // The motivating query: "have we ever funded youth mental health".
    const hits = await searchApplications(db, adminSession(), 'youth mental health');
    expect(hits.map((h) => h.application_id)).toContain(s.applicationId);

    const byCounty = await searchApplications(db, adminSession(), 'fort_bend');
    expect(byCounty.map((h) => h.application_id)).toContain(s.applicationId);

    const miss = await searchApplications(db, adminSession(), 'zzzznotpresent');
    expect(miss).toEqual([]);
  });

  it('rejects an incomplete submission with every error at once and writes nothing', async () => {
    const s = await setup();
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, { contact_first_name: 'Alex' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 400 });

    const app = await db
      .prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(s.applicationId)
      .first<{ status: string }>();
    expect(app!.status).toBe('draft');

    const answers = await db
      .prepare(`SELECT COUNT(*) AS n FROM application_answers WHERE application_id = ?`)
      .bind(s.applicationId)
      .first<{ n: number }>();
    expect(answers!.n).toBe(0); // nothing partially written
  });

  it('refuses a second submit', async () => {
    const s = await setup();
    await submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts));
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a submit from another organization with a 404', async () => {
    const s = await setup();
    const other = await seedOrganization(db, ctxFor(adminSession()), ORG_FIXTURES[1]!);
    const otherSession = applicantSession(other.organizationId, other.userId);
    await expect(
      submitApplication(db, ctxFor(otherSession), otherSession, s.applicationId, fullPayload(s.atts)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('refuses a submit after the cycle closes', async () => {
    const s = await setup({ closesAt: '2020-06-01T00:00:00.000Z' });
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts)),
    ).rejects.toMatchObject({ code: 'CYCLE_CLOSED' });

    // And the draft survives: a closed cycle must never destroy work.
    const app = await db
      .prepare(`SELECT status FROM applications WHERE id = ?`)
      .bind(s.applicationId)
      .first<{ status: string }>();
    expect(app!.status).toBe('draft');
  });
});

describe('autosave', () => {
  it('saves a partial draft and audits it', async () => {
    const s = await setup();
    const { errors } = await saveDraft(db, s.ctx, s.session, s.applicationId, {
      contact_first_name: 'Alex',
      project_title: 'Literacy Lab',
    });
    expect(errors).toEqual([]);

    const rows = await db
      .prepare(`SELECT field_key FROM application_answers WHERE application_id = ? ORDER BY field_key`)
      .bind(s.applicationId)
      .all<{ field_key: string }>();
    expect(rows.results.map((r) => r.field_key)).toEqual(['contact_first_name', 'project_title']);

    const audit = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action='application.answer_saved'`)
      .bind(s.applicationId)
      .first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it('does not index a draft for search', async () => {
    const s = await setup();
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      project_summary: 'A distinctive draft phrase quixotic',
    });
    const hits = await searchApplications(db, adminSession(), 'quixotic');
    expect(hits).toEqual([]);
  });

  it('is idempotent: saving twice updates rather than duplicating', async () => {
    const s = await setup();
    await saveDraft(db, s.ctx, s.session, s.applicationId, { project_title: 'First' });
    await saveDraft(db, s.ctx, s.session, s.applicationId, { project_title: 'Second' });
    const rows = await db
      .prepare(`SELECT value_text FROM application_answers WHERE application_id = ? AND field_key='project_title'`)
      .bind(s.applicationId)
      .all<{ value_text: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.value_text).toBe('Second');
  });

  it('clears an answer that is no longer visible', async () => {
    const s = await setup();
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      funding_type: 'other',
      funding_type_other: 'Arts education',
    });
    let rows = await db
      .prepare(`SELECT field_key FROM application_answers WHERE application_id = ? AND field_key='funding_type_other'`)
      .bind(s.applicationId)
      .all();
    expect(rows.results).toHaveLength(1);

    // Applicant changes their mind. The stale "other" detail must not survive.
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      funding_type: 'programs',
      funding_type_other: 'Arts education',
    });
    rows = await db
      .prepare(`SELECT field_key FROM application_answers WHERE application_id = ? AND field_key='funding_type_other'`)
      .bind(s.applicationId)
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it('refuses to autosave over a submitted application', async () => {
    const s = await setup();
    await submitApplication(db, s.ctx, s.session, s.applicationId, fullPayload(s.atts));
    await expect(
      saveDraft(db, s.ctx, s.session, s.applicationId, { project_title: 'Sneaky edit' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('FTS query escaping', () => {
  it('neutralizes FTS5 syntax from a search box', () => {
    expect(toFtsQuery('youth mental health')).toBe('"youth" AND "mental" AND "health"');
    expect(toFtsQuery('OR NOT NEAR')).toBe('"OR" AND "NOT" AND "NEAR"');
    expect(toFtsQuery('"; DROP')).toBe('";" AND "DROP"');
    expect(toFtsQuery('   ')).toBeNull();
  });

  it('does not throw on hostile input', async () => {
    for (const q of ['*', '""', 'a OR (b', 'x" OR "1"="1']) {
      await expect(searchApplications(db, adminSession(), q)).resolves.toBeInstanceOf(Array);
    }
  });
});
