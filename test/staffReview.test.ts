import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { submitApplication } from '../src/lib/submit';
import { getApplicationDetailForStaff, INTERNAL_ONLY_COLUMNS } from '../src/lib/scope';
import { presignDownloadForStaff } from '../src/lib/downloads';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Session } from '../src/types';

/**
 * A reviewer opening a real submitted application.
 *
 * WHY THIS FILE EXISTS. Every piece of this has unit tests and none of them
 * had met an application that a person actually submitted, with files actually
 * in R2. That gap is where every fault in this project has lived: two correct
 * halves and a join nobody had walked.
 *
 * What it checks that the per-function tests do not: that the three uploads on
 * a submitted application reach the detail view at all, that a reviewer with
 * no assignment gets nothing, that one WITH an assignment gets the budget they
 * are being asked to score against, that a download is attributable, and that
 * nothing on the reviewer's copy carries another reviewer's words.
 */

const env = (): Env => ({
  ...(testEnv as unknown as Env),
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
});

let n = 0;

function payload(atts: { fin: string; op: string }) {
  return {
    entity_type_confirmation: true,
    guidelines_attestation: true,
    authorization_attestation: true,
    salutation: 'ms',
    contact_first_name: 'Alex',
    contact_last_name: 'Moreno',
    contact_email: `director-${n}@example-invented.org`,
    contact_phone: '(713) 555-0123',
    contact_job_title: 'Executive Director',
    organization_name: 'Bayou Reach Collective',
    ein: '00-1234567',
    organization_website: 'example-bayoureach.org',
    organization_address: {
      address_1: '100 Example Street', city: 'Houston', state: 'tx',
      postal_code: '77002', country: 'US',
    },
    mission_statement: 'Expanding after-school literacy programs.',
    annual_operating_budget: '$825,000',
    project_title: 'Literacy Lab',
    requested_amount: '$25,000.07',
    funding_type: 'programs',
    area_of_focus: 'education',
    counties_served: ['harris', 'fort_bend'],
    advancing_opportunity: 'We serve students with limited access to tutoring.',
    project_summary: 'Reading intervention for 400 students.',
    community_need: 'Reading proficiency trails the state average considerably.',
    implementation_timeline: 'Hire in August, launch in September.',
    individuals_benefiting: 'Approximately 400 students, grades 3 through 8.',
    estimated_individuals_count: '400',
    leadership_lived_experience: 'Our board includes parents and alumni.',
    partial_funding_plan: 'We would reduce the number of sites from four to two.',
    volunteer_engagement: 'Reading buddy sessions and a supply drive.',
    itemized_budget: 'Tutors $12,000. Materials $5,000. Evaluation $8,007.',
    financial_statements: [{ attachment_id: atts.fin, filename: 'audit-2025.pdf' }],
    operating_budget_doc: [{ attachment_id: atts.op, filename: 'operating.xlsx' }],
    marketing_opt_in: true,
  };
}

/** An application somebody actually submitted, with its three uploads. */
async function submitted() {
  const adminCtx = ctxFor(adminSession());
  const program = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `sr-${++n}` });
  const org = await seedOrganization(db, adminCtx, {
    ...ORG_FIXTURES[0]!,
    ein: String(980000000 + n),
    email: `dir-${n}@example-bayoureach.org`,
  });
  const cycleId = Object.values(program.cycleIds)[0]!;
  await db.prepare(
    `UPDATE cycles SET opens_at='2020-01-01T00:00:00.000Z',
       closes_at='2099-01-01T00:00:00.000Z', status='open' WHERE id=?`,
  ).bind(cycleId).run();

  const applicationId = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
       status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'draft', ?, ?)`,
  ).bind(applicationId, cycleId, program.stageIds.application!, org.organizationId,
         program.formDefinitionIds.application!, now, now).run();

  /*
   * ONE ATTACHMENT PER UPLOAD FIELD THE FORM ACTUALLY HAS.
   *
   * The first version of this fixture made three and expected three back, and
   * got two -- because the seeded Inspire Change form has two file_upload
   * fields, not the three CLAUDE.md's reference list describes. The third
   * attachment was created, never claimed by any answer, and correctly left
   * off the application. The count is read from the definition now, so the
   * test cannot disagree with the form about how many documents exist.
   */
  const atts = { fin: newId(), op: newId() };
  for (const [key, id] of Object.entries(atts)) {
    await db.prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, 'application', null, org.organizationId, `r2/${id}`, `${key}-2025.pdf`,
           'application/pdf', 218_056, now).run();
  }

  const session: Session = applicantSession(org.organizationId, org.userId);
  await submitApplication(db, ctxFor(session), session, applicationId, payload(atts));
  // How many documents this form asks for, read from the form itself.
  const uploadFields = await db.prepare(
    `SELECT COUNT(*) AS n FROM form_fields
      WHERE form_definition_id = ? AND field_type = 'file_upload'`,
  ).bind(program.formDefinitionIds.application!).first<{ n: number }>();

  return { applicationId, org, program, cycleId, atts, uploadCount: uploadFields!.n };
}

const admin = adminSession();

describe('a reviewer opening a submitted application', () => {
  it('shows the uploads the applicant actually sent', async () => {
    const s = await submitted();
    const detail = await getApplicationDetailForStaff(db, admin, s.applicationId);
    const attachments = detail.attachments as { id: string; filename: string }[];
    // One per upload field the form asks for. Fewer means a claimed
    // attachment never reached the parent -- which the applicant cannot see
    // and staff cannot fix.
    expect(s.uploadCount).toBeGreaterThan(0);
    expect(attachments.length).toBe(s.uploadCount);
    expect(attachments.every((a) => a.filename.endsWith('.pdf'))).toBe(true);
  });

  it('gives a reviewer with no assignment nothing at all', async () => {
    const s = await submitted();
    const err = await appErrorFrom(
      getApplicationDetailForStaff(db, reviewerSession(), s.applicationId),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  it('gives an ASSIGNED reviewer the budget they are being asked to score', async () => {
    /*
     * The rubric asks about the itemized spending budget. A reviewer who can
     * see the question and not the document is being asked to score a thing
     * they cannot read.
     */
    const s = await submitted();
    const reviewer = reviewerSession();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'reviewer', NULL, 1, ?, ?)`,
    ).bind(reviewer.userId, `rev-${n}@example.org`, nowIso(), nowIso()).run();
    await db.prepare(
      `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), s.applicationId, reviewer.userId, nowIso(), nowIso(), nowIso()).run();

    const detail = await getApplicationDetailForStaff(db, reviewer, s.applicationId);
    expect((detail.attachments as unknown[]).length).toBe(s.uploadCount);
  });

  it('carries no internal note or decision rationale on the reviewer copy', async () => {
    const s = await submitted();
    const reviewer = reviewerSession();
    await db.prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'reviewer', NULL, 1, ?, ?)`,
    ).bind(reviewer.userId, `rev2-${n}@example.org`, nowIso(), nowIso()).run();
    await db.prepare(
      `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(newId(), s.applicationId, reviewer.userId, nowIso(), nowIso(), nowIso()).run();
    await db.prepare(
      `UPDATE applications SET internal_notes = ?, decision_notes = ? WHERE id = ?`,
    ).bind('STAFF ONLY the board is thin', 'declined, weakest of the cohort', s.applicationId).run();

    const detail = await getApplicationDetailForStaff(db, reviewer, s.applicationId);
    const text = JSON.stringify(detail);
    expect(text).not.toContain('STAFF ONLY');
    expect(text).not.toContain('weakest of the cohort');
    const app = detail.application as Record<string, unknown>;
    const leaked = INTERNAL_ONLY_COLUMNS.filter((c) => c in app);
    expect(leaked, 'internal columns on a reviewer projection').toEqual([]);
  });

  it('renders a file answer as filenames, not as the JSON it is stored as', async () => {
    /*
     * A file_upload answer is stored as [{attachment_id, filename}]. A detail
     * screen that printed that raw would show a staff member a UUID where a
     * document name belongs -- correct, and unreadable.
     */
    const s = await submitted();
    const detail = await getApplicationDetailForStaff(db, admin, s.applicationId);
    const answers = detail.answers as Record<string, { value_json: string | null }>;
    const fin = answers.financial_statements;
    expect(fin, 'the financial statements answer reached the detail').toBeTruthy();
    const parsed = JSON.parse(fin!.value_json ?? '[]') as { filename: string }[];
    expect(parsed[0]?.filename).toBe('audit-2025.pdf');
  });
});

describe('a staff member opening one of those files', () => {
  it('issues a short-lived link, and records who asked', async () => {
    const s = await submitted();
    const detail = await getApplicationDetailForStaff(db, admin, s.applicationId);
    const first = (detail.attachments as { id: string }[])[0]!;

    const grant = await presignDownloadForStaff(env(), ctxFor(admin), admin, first.id);
    expect(grant.url).toContain('X-Amz-Signature');
    // Forced download, opaque type: a hostile HTML or SVG upload cannot be
    // talked into rendering on this origin.
    expect(decodeURIComponent(grant.url)).toContain('attachment;');

    const audit = await db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE entity_id = ? AND action LIKE 'attachment%'`,
    ).bind(first.id).first<{ n: number }>();
    expect(audit!.n).toBeGreaterThan(0);
  });

  it('stamps the attachment, which is what the retention screen reads', async () => {
    /*
     * The retention screen's "Asked for" column is how somebody decides
     * whether a financial statement can be destroyed tonight. It reads this
     * stamp, so a download that does not set it makes a file look untouched.
     */
    const s = await submitted();
    const detail = await getApplicationDetailForStaff(db, admin, s.applicationId);
    const first = (detail.attachments as { id: string }[])[0]!;

    const before = await db.prepare(
      `SELECT download_url_first_issued_at AS at FROM attachments WHERE id = ?`,
    ).bind(first.id).first<{ at: string | null }>();
    expect(before!.at).toBeNull();

    await presignDownloadForStaff(env(), ctxFor(admin), admin, first.id);

    const after = await db.prepare(
      `SELECT download_url_first_issued_at AS at, download_url_issue_count AS n
         FROM attachments WHERE id = ?`,
    ).bind(first.id).first<{ at: string | null; n: number }>();
    expect(after!.at).not.toBeNull();
    expect(after!.n).toBeGreaterThan(0);
  });

  it('refuses a reviewer with no assignment', async () => {
    const s = await submitted();
    const detail = await getApplicationDetailForStaff(db, admin, s.applicationId);
    const first = (detail.attachments as { id: string }[])[0]!;
    const err = await appErrorFrom(
      presignDownloadForStaff(env(), ctxFor(reviewerSession()), reviewerSession(), first.id),
    );
    expect(err.code).toBe('NOT_FOUND');
  });
});
