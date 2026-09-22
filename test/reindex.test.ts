import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, applicantSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { submitApplication } from '../src/lib/submit';
import { searchApplications } from '../src/lib/search';
import { reindexAllApplications } from '../src/lib/reindex';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Session } from '../src/types';

/**
 * Rebuilding the full-text index.
 *
 * WHAT THIS IS FOR. The nightly export skips virtual tables, so a restored
 * database has an empty `application_fts` and a fully populated
 * `application_search_state` -- an index that finds nothing while reporting
 * itself current. Until reindex.ts existed, nothing in this system could
 * rebuild it, because the only writer was submit. The scenario below is that
 * state exactly: the index dropped, the bookkeeping left behind.
 */

function payload(atts: { budget: string; fin: string; op: string }, over: Record<string, unknown> = {}) {
  return {
    entity_type_confirmation: true,
    guidelines_attestation: true,
    authorization_attestation: true,
    salutation: 'ms',
    contact_first_name: 'Alex',
    contact_last_name: 'Moreno',
    contact_email: over.contact_email ?? 'director@example-bayoureach.org',
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

let n = 0;

async function submitted() {
  const adminCtx = ctxFor(adminSession());
  const program = await seedProgram(db, adminCtx, { ...INSPIRE_CHANGE, slug: `rdx-${++n}` });
  const org = await seedOrganization(db, adminCtx, {
    ...ORG_FIXTURES[0]!,
    ein: String(950000000 + n),
    // Unique per scenario: users.email is unique, and two scenarios in one
    // test would otherwise collide on the fixture's single address.
    email: `director-${n}@example-bayoureach.org`,
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
     VALUES (?,?,?,?,?,'draft',?,?)`,
  ).bind(applicationId, cycleId, program.stageIds.application!, org.organizationId,
         program.formDefinitionIds.application!, now, now).run();

  const atts = { budget: newId(), fin: newId(), op: newId() };
  for (const [key, id] of Object.entries(atts)) {
    await db.prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, 'application', null, org.organizationId, `r2/${id}`, `${key}.pdf`,
           'application/pdf', 1024, now).run();
  }

  const session: Session = applicantSession(org.organizationId, org.userId);
  await submitApplication(db, ctxFor(session), session, applicationId, payload(atts));
  return { applicationId, org, adminCtx, program, cycleId };
}

/** A restored database: the index gone, the bookkeeping left behind. */
async function asIfRestored(): Promise<void> {
  await db.prepare(`DELETE FROM application_fts`).run();
}

const admin = adminSession();

describe('rebuilding the search index', () => {
  it('finds nothing after a restore, and everything after a rebuild', async () => {
    const s = await submitted();

    const beforeLoss = await searchApplications(db, admin, 'literacy');
    expect(beforeLoss.length, 'the submit path indexed it').toBeGreaterThan(0);

    await asIfRestored();
    const lost = await searchApplications(db, admin, 'literacy');
    expect(lost.length, 'this is the state a restore leaves behind').toBe(0);
    // And the bookkeeping still claims it is indexed, which is the trap.
    const state = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_search_state WHERE application_id=?`,
    ).bind(s.applicationId).first<{ n: number }>();
    expect(state!.n, 'the index says it is current while finding nothing').toBe(1);

    const result = await reindexAllApplications(db, ctxFor(admin));
    expect(result.failed).toEqual([]);
    expect(result.indexed).toBeGreaterThan(0);

    const found = await searchApplications(db, admin, 'literacy');
    expect(found.map((r) => r.application_id)).toContain(s.applicationId);
  });

  it('rebuilds every searchable field, not just the one the test looked for', async () => {
    const s = await submitted();
    await asIfRestored();
    await reindexAllApplications(db, ctxFor(admin));

    // A rebuild that populated `narrative` and left `project_title` empty
    // would pass a single-term test and fail the question staff actually ask.
    for (const term of ['literacy', 'mental', 'reading']) {
      const r = await searchApplications(db, admin, term);
      expect(r.map((x) => x.application_id), `searching for ${term}`).toContain(s.applicationId);
    }
    const row = await db.prepare(
      `SELECT organization_name, ein, project_title, counties, focus_area
         FROM application_fts WHERE application_id=?`,
    ).bind(s.applicationId).first<Record<string, string>>();
    expect(Object.values(row!).filter((v) => !v || v.length === 0)).toEqual([]);
  });

  it('is idempotent, because the person running it is having a bad day', async () => {
    const s = await submitted();
    await asIfRestored();
    await reindexAllApplications(db, ctxFor(admin));
    const once = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_fts WHERE application_id=?`,
    ).bind(s.applicationId).first<{ n: number }>();
    await reindexAllApplications(db, ctxFor(admin));
    const twice = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_fts WHERE application_id=?`,
    ).bind(s.applicationId).first<{ n: number }>();
    expect([once!.n, twice!.n]).toEqual([1, 1]);
  });

  it('does not index a draft, and clears a stale entry for one', async () => {
    const s = await submitted();
    // Sent back to draft, the way a withdrawal or a correction would.
    // submitted_at has to go too: applications carries
    // CHECK (status <> 'draft' OR submitted_at IS NULL), which is the schema
    // refusing to describe a draft that was also submitted.
    await db.prepare(`UPDATE applications SET status='draft', submitted_at=NULL WHERE id=?`)
      .bind(s.applicationId).run();
    const result = await reindexAllApplications(db, ctxFor(admin));
    expect(result.cleared).toBeGreaterThan(0);
    const left = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_fts WHERE application_id=?`,
    ).bind(s.applicationId).first<{ n: number }>();
    expect(left!.n, 'a draft must not be findable').toBe(0);
    const found = await searchApplications(db, admin, 'literacy');
    expect(found.map((r) => r.application_id)).not.toContain(s.applicationId);
  });

  it('reports an application it could not rebuild instead of stopping', async () => {
    const s = await submitted();
    await asIfRestored();
    // A form definition that is gone is the shape of the problem: something
    // upstream of this application is missing, and the other 399 applications
    // must still get their index back.
    const other = await submitted();
    /*
     * SOFT-DELETED, not repointed at an invented id. The foreign key refuses
     * an id that does not exist, which is the schema being right -- so the
     * realistic way for a rebuild to fail is the one this system actually
     * permits: a form definition that has been removed while an application
     * still refers to it. loadFormDefinition filters on deleted_at.
     */
    await db.prepare(`UPDATE form_definitions SET deleted_at=? WHERE id=?`)
      .bind(nowIso(), s.program.formDefinitionIds.application!).run();

    const result = await reindexAllApplications(db, ctxFor(admin));
    expect(result.failed.map((f) => f.applicationId)).toContain(s.applicationId);
    expect(result.indexed, 'the healthy ones still got rebuilt').toBeGreaterThan(0);
    const ok = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_fts WHERE application_id=?`,
    ).bind(other.applicationId).first<{ n: number }>();
    expect(ok!.n).toBe(1);
  });

  it('writes an audit row, because it changes what staff can find', async () => {
    await submitted();
    await asIfRestored();
    await reindexAllApplications(db, ctxFor(admin));
    const row = await db.prepare(
      `SELECT action, entity_type, after_json FROM audit_log
        WHERE action='search.reindexed' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ action: string; entity_type: string; after_json: string }>();
    expect(row?.entity_type).toBe('search_index');
    expect(JSON.parse(row!.after_json).indexed).toBeGreaterThan(0);
  });
});
