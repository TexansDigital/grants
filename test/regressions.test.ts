import { describe, it, expect } from 'vitest';
import { db, ctxFor, adminSession, applicantSession, reviewerSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { seedOrganization, ORG_FIXTURES } from '../src/seed/fixtures';
import { saveDraft, submitApplication } from '../src/lib/submit';
import { searchApplications } from '../src/lib/search';
import {
  getApplicationForExternal,
  listApplicationsForExternal,
  assertOwnedByExternalSession,
  APPLICANT_APPLICATION_COLUMNS,
  INTERNAL_ONLY_COLUMNS,
} from '../src/lib/scope';
import { isFieldVisible, validateSubmission, loadFormDefinition, allFields } from '../src/lib/forms';
import { isCycleAcceptingSubmission, nowIso } from '../src/lib/time';
import { newId } from '../src/lib/ids';
import type { FieldDef } from '../src/lib/fieldTypes';

/**
 * Regression tests for defects found by adversarial review of the first build.
 * Each test names the defect it pins. Every one of these failed before its fix.
 */

async function scenario(over: { closesAt?: string; cycleStatus?: string } = {}) {
  const adminCtx = ctxFor(adminSession());
  const program = await seedProgram(db, adminCtx, INSPIRE_CHANGE);
  const org = await seedOrganization(db, adminCtx, ORG_FIXTURES[0]!);
  const cycleId = Object.values(program.cycleIds)[0]!;
  const now = nowIso();

  await db
    .prepare(`UPDATE cycles SET opens_at=?, closes_at=?, status=? WHERE id=?`)
    .bind(
      '2020-01-01T00:00:00.000Z',
      over.closesAt ?? '2099-01-01T00:00:00.000Z',
      over.cycleStatus ?? 'open',
      cycleId,
    )
    .run();

  const applicationId = newId();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,?)`,
    )
    .bind(
      applicationId,
      cycleId,
      program.stageIds.application!,
      org.organizationId,
      program.formDefinitionIds.application!,
      now,
      now,
    )
    .run();

  const atts = { budget: newId(), fin: newId(), op: newId() };
  for (const [k, id] of Object.entries(atts)) {
    await db
      .prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key, filename, mime_type, size_bytes, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(id, 'application', null, org.organizationId, `r2/${id}`, `${k}.pdf`, 'application/pdf', 1024, now)
      .run();
  }

  const session = applicantSession(org.organizationId, org.userId);
  return { program, org, cycleId, applicationId, atts, session, ctx: ctxFor(session) };
}

function payload(
  atts: { budget: string; fin: string; op: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entity_type_confirmation: true,
    guidelines_attestation: true,
    authorization_attestation: true,
    contact_first_name: 'Alex',
    contact_last_name: 'Moreno',
    contact_email: 'director@example-bayoureach.org',
    contact_phone: '7135550123',
    contact_job_title: 'Executive Director',
    organization_name: 'Bayou Reach Collective',
    ein: '00-1234567',
    organization_website: 'example-bayoureach.org',
    organization_address: { address_1: '100 Example St', city: 'Houston', state: 'TX', postal_code: '77002' },
    mission_statement: 'Literacy programs.',
    annual_operating_budget: '$825,000',
    project_title: 'Literacy Lab',
    // NOT $25,000.07: that value survives float math exactly, which is how the
    // original end-to-end money test passed against a deliberately broken parser.
    requested_amount: '$19,999.99',
    funding_type: 'program',
    area_of_focus: 'youth_development',
    counties_served: ['harris'],
    advancing_opportunity: 'Serving students.',
    project_summary: 'Reading support.',
    community_need: 'Reading proficiency trails.',
    implementation_timeline: 'Hire, launch, evaluate.',
    individuals_benefiting: 'About 400 students.',
    estimated_individuals_count: '400',
    leadership_lived_experience: 'Board includes parents.',
    partial_funding_plan: 'Fewer sites.',
    itemized_budget: [{ attachment_id: atts.budget, filename: 'budget.pdf' }],
    financial_statements: [{ attachment_id: atts.fin, filename: 'audit.pdf' }],
    operating_budget_doc: [{ attachment_id: atts.op, filename: 'op.xlsx' }],
    marketing_opt_in: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('CRITICAL: concurrent double-submit cannot corrupt the amount', () => {
  it('the loser writes nothing and is told so', async () => {
    const s = await scenario();

    // Two separate requests, as two browser tabs would be.
    const results = await Promise.allSettled([
      submitApplication(db, ctxFor(s.session), s.session, s.applicationId,
        payload(s.atts, { requested_amount: '$10,000.00' })),
      submitApplication(db, ctxFor(s.session), s.session, s.applicationId,
        payload(s.atts, { requested_amount: '$90,000.00' })),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok, 'exactly one submit may succeed').toHaveLength(1);

    const app = await db
      .prepare(`SELECT requested_amount_cents AS c FROM applications WHERE id=?`)
      .bind(s.applicationId)
      .first<{ c: number }>();
    const answer = await db
      .prepare(`SELECT value_int AS c FROM application_answers WHERE application_id=? AND field_key='requested_amount'`)
      .bind(s.applicationId)
      .first<{ c: number }>();

    // The original bug: the promoted column said $10,000 while the answer row
    // it was supposedly derived from said $90,000.
    expect(app!.c).toBe(answer!.c);

    const audits = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id=? AND action='application.submitted'`)
      .bind(s.applicationId)
      .first<{ n: number }>();
    expect(audits!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('HIGH: partial autosave must not destroy answers it never saw', () => {
  it('keeps a conditional answer when a different section is saved', async () => {
    const s = await scenario();
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      area_of_focus: 'other',
      area_of_focus_other: 'Disaster relief logistics',
    });

    // Autosave of an unrelated section. The parent of area_of_focus_other is
    // simply absent from this payload; that is not the applicant clearing it.
    await saveDraft(db, s.ctx, s.session, s.applicationId, { project_title: 'Literacy Lab' });

    const row = await db
      .prepare(`SELECT value_text AS v FROM application_answers WHERE application_id=? AND field_key='area_of_focus_other'`)
      .bind(s.applicationId)
      .first<{ v: string }>();
    expect(row?.v).toBe('Disaster relief logistics');
  });

  it('still clears it when the applicant actually changes the parent', async () => {
    const s = await scenario();
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      area_of_focus: 'other',
      area_of_focus_other: 'Arts education',
    });
    await saveDraft(db, s.ctx, s.session, s.applicationId, { area_of_focus: 'education' });

    const rows = await db
      .prepare(`SELECT 1 FROM application_answers WHERE application_id=? AND field_key='area_of_focus_other'`)
      .bind(s.applicationId)
      .all();
    expect(rows.results).toHaveLength(0);
  });

  // The protection has TWO independently sufficient mechanisms. The behavioural
  // test above passes if either survives, so each is pinned separately here --
  // otherwise a refactor could quietly remove one and nothing would notice.
  it('mechanism 1: stored answers seed the visibility computation', async () => {
    const s = await scenario();
    const def = await loadFormDefinition(db, s.program.formDefinitionIds.application!);
    const parent = allFields(def).find((f) => f.field_key === 'area_of_focus')!;
    const child = allFields(def).find((f) => f.field_key === 'area_of_focus_other')!;

    // Parent answered previously, absent from this payload. Checked in
    // NON-partial mode, where the parent-was-posted guard does not apply, so
    // only the stored-answer merge can keep the child visible.
    const existing = new Map([[parent.id, { value_text: 'other', value_int: null, value_real: null, value_json: null }]]);
    const outcome = validateSubmission(def, { project_title: 'x' }, { existingAnswers: existing });
    expect(outcome.hiddenFieldIds).not.toContain(child.id);
  });

  it('mechanism 2: a parent absent from the request never clears its child', async () => {
    const s = await scenario();
    const def = await loadFormDefinition(db, s.program.formDefinitionIds.application!);
    const child = allFields(def).find((f) => f.field_key === 'area_of_focus_other')!;

    // No stored answers supplied at all: the parent is unknown, not "cleared".
    const outcome = validateSubmission(def, { project_title: 'x' }, { partial: true });
    expect(outcome.hiddenFieldIds).not.toContain(child.id);
  });

  it('records what it cleared, so the text is recoverable from the audit trail', async () => {
    const s = await scenario();
    await saveDraft(db, s.ctx, s.session, s.applicationId, {
      area_of_focus: 'other',
      area_of_focus_other: 'Recoverable text',
    });
    await saveDraft(db, s.ctx, s.session, s.applicationId, { area_of_focus: 'education' });

    const audit = await db
      .prepare(
        `SELECT before_json FROM audit_log WHERE entity_id=? AND before_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(s.applicationId)
      .first<{ before_json: string }>();
    expect(audit?.before_json).toContain('Recoverable text');
  });
});

// ---------------------------------------------------------------------------
describe('HIGH: cycle and form status are honoured, not just dates', () => {
  it('refuses a submit into an administratively closed cycle with open dates', async () => {
    const s = await scenario({ cycleStatus: 'closed' });
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts)),
    ).rejects.toMatchObject({ code: 'CYCLE_CLOSED' });
  });

  it('refuses a submit against a retired form definition', async () => {
    const s = await scenario();
    await db
      .prepare(`UPDATE form_definitions SET status='retired' WHERE id=?`)
      .bind(s.program.formDefinitionIds.application!)
      .run();
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('fails closed on a malformed cycle window instead of accepting', () => {
    for (const bad of ['', 'garbage', 'not-a-date']) {
      expect(
        isCycleAcceptingSubmission({
          opensAt: bad,
          closesAt: '2099-01-01T00:00:00.000Z',
          graceHours: 0,
          status: 'open',
        }).accepted,
        bad,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('HIGH: attachment references are validated against the owning organization', () => {
  it('rejects an attachment belonging to another organization', async () => {
    const s = await scenario();
    const other = await seedOrganization(db, ctxFor(adminSession()), ORG_FIXTURES[1]!);
    const stolen = newId();
    await db
      .prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key, filename, mime_type, size_bytes, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(stolen, 'application', null, other.organizationId, `r2/${stolen}`, 'their-audit.pdf', 'application/pdf', 2048, nowIso())
      .run();

    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId,
        payload(s.atts, { financial_statements: [{ attachment_id: stolen, filename: 'their-audit.pdf' }] })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an attachment id that does not exist', async () => {
    const s = await scenario();
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId,
        payload(s.atts, { itemized_budget: [{ attachment_id: 'made-up-id', filename: 'x.pdf' }] })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('claims valid attachments onto the application', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    const row = await db
      .prepare(`SELECT parent_id FROM attachments WHERE id=?`)
      .bind(s.atts.budget)
      .first<{ parent_id: string }>();
    expect(row?.parent_id).toBe(s.applicationId);
  });
});

// ---------------------------------------------------------------------------
describe('HIGH: append-only survives INSERT OR REPLACE', () => {
  it('blocks a REPLACE rewrite of an audit row', async () => {
    const id = newId();
    await db
      .prepare(
        `INSERT INTO audit_log (id, actor_kind, action, entity_type, entity_id, after_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(id, 'user', 'award.created', 'award', 'aw-1', '{"amount_cents":5000000}', nowIso())
      .run();

    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO audit_log (id, actor_kind, action, entity_type, entity_id, after_json, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(id, 'system', 'award.created', 'award', 'aw-1', '{"amount_cents":1}', nowIso())
        .run(),
    ).rejects.toThrow(/append-only/);

    const row = await db.prepare(`SELECT after_json AS j FROM audit_log WHERE id=?`).bind(id).first<{ j: string }>();
    expect(row?.j).toContain('5000000');
  });

  it('blocks a REPLACE rewrite of an error row', async () => {
    const id = newId();
    await db
      .prepare(`INSERT INTO error_log (id, severity, code, message, created_at) VALUES (?,?,?,?,?)`)
      .bind(id, 'error', 'INTERNAL', 'original', nowIso())
      .run();
    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO error_log (id, severity, code, message, created_at) VALUES (?,?,?,?,?)`)
        .bind(id, 'warn', 'INTERNAL', 'scrubbed', nowIso())
        .run(),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
describe('CRITICAL: published form definitions really are immutable', () => {
  it('blocks the retired-to-draft laundering route', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const id = p.formDefinitionIds.application!;
    await db.prepare(`UPDATE form_definitions SET status='retired' WHERE id=?`).bind(id).run();
    // Retire, edit every label, re-publish was the whole exploit.
    await expect(
      db.prepare(`UPDATE form_definitions SET status='draft' WHERE id=?`).bind(id).run(),
    ).rejects.toThrow(/cannot return to draft/);
  });

  it('freezes published_at', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    await expect(
      db
        .prepare(`UPDATE form_definitions SET published_at='2000-01-01T00:00:00.000Z' WHERE id=?`)
        .bind(p.formDefinitionIds.application!)
        .run(),
    ).rejects.toThrow(/published_at cannot be changed/);
  });

  it('blocks moving a field out of a draft and into a published definition', async () => {
    const ctx = ctxFor(adminSession());
    const published = await seedProgram(db, ctx, INSPIRE_CHANGE);
    const draft = await seedProgram(
      db, ctx, { ...INSPIRE_CHANGE, slug: 'draft-prog', name: 'Draft Prog' }, { publish: false });

    const victimSection = await db
      .prepare(`SELECT id FROM form_sections WHERE form_definition_id=? LIMIT 1`)
      .bind(published.formDefinitionIds.application!)
      .first<{ id: string }>();
    const movable = await db
      .prepare(`SELECT id FROM form_fields WHERE form_definition_id=? LIMIT 1`)
      .bind(draft.formDefinitionIds.application!)
      .first<{ id: string }>();

    await expect(
      db
        .prepare(`UPDATE form_fields SET form_definition_id=?, form_section_id=?, field_key='smuggled' WHERE id=?`)
        .bind(published.formDefinitionIds.application!, victimSection!.id, movable!.id)
        .run(),
    ).rejects.toThrow(/published|must match/);
  });
});

// ---------------------------------------------------------------------------
describe('money: the database and the binding site both hold', () => {
  it('stores a float-unsafe amount exactly, end to end', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    const app = await db
      .prepare(`SELECT requested_amount_cents AS c FROM applications WHERE id=?`)
      .bind(s.applicationId)
      .first<{ c: number }>();
    expect(app!.c).toBe(1_999_999); // $19,999.99
  });

  it('rejects a float in application_answers.value_int', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO application_answers (id, application_id, form_field_id, field_key, label_at_answer, field_type, value_int, answered_at)
           VALUES ('x','a','f','k','L','currency', 25000.5, datetime('now'))`,
        )
        .run(),
    ).rejects.toThrow(/CHECK|FOREIGN/i);
  });

  it('rejects money stored as text beside a currency field', async () => {
    const s = await scenario();
    const field = await db
      .prepare(`SELECT id FROM form_fields WHERE form_definition_id=? AND field_key='requested_amount'`)
      .bind(s.program.formDefinitionIds.application!)
      .first<{ id: string }>();
    await expect(
      db
        .prepare(
          `INSERT INTO application_answers (id, application_id, form_field_id, field_key, label_at_answer, field_type, value_text, answered_at)
           VALUES (?,?,?,'requested_amount','Amount','currency','25000.50',datetime('now'))`,
        )
        .bind(newId(), s.applicationId, field!.id)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('rejects an out-of-range amount', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, requested_amount_cents, created_at, updated_at)
           VALUES ('r','c','s','o','f','draft', 99999999999999, datetime('now'), datetime('now'))`,
        )
        .run(),
    ).rejects.toThrow(/CHECK|FOREIGN/i);
  });
});

// ---------------------------------------------------------------------------
describe('audit coverage', () => {
  it('writes one row per mutating action when seeding a program', async () => {
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).first<{ n: number }>();
    await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    const { results } = await db.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action`).all<{ action: string }>();
    const actions = new Set(results.map((r) => r.action));

    for (const a of [
      'program.created', 'program_stage.created', 'form_definition.created',
      'form_section.created', 'form_field.created', 'form_definition.published', 'cycle.created',
    ]) {
      expect(actions, `missing audit action ${a}`).toContain(a);
    }
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).first<{ n: number }>();
    // One per field, not one per program: stripping every audit call from the
    // seeder previously left the whole suite green.
    expect(after!.n).toBeGreaterThan(before!.n + 30);
  });

  it('audits a login-capable user separately from its organization', async () => {
    await seedOrganization(db, ctxFor(adminSession()), ORG_FIXTURES[2]!);
    const { results } = await db.prepare(`SELECT action FROM audit_log`).all<{ action: string }>();
    const actions = results.map((r) => r.action);
    expect(actions).toContain('organization.created');
    expect(actions).toContain('contact.created');
    expect(actions).toContain('user.created');
  });

  it('writes NO audit row when the batch it belongs to fails', async () => {
    const s = await scenario();
    await expect(
      submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts, { requested_amount: 'not a number' })),
    ).rejects.toBeTruthy();

    const audits = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id=? AND action='application.submitted'`)
      .bind(s.applicationId)
      .first<{ n: number }>();
    expect(audits!.n).toBe(0);
    const app = await db.prepare(`SELECT status FROM applications WHERE id=?`).bind(s.applicationId).first<{ status: string }>();
    expect(app!.status).toBe('draft');
  });

  it('does not copy submission IP into the audit snapshot, at any depth', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    const audit = await db
      .prepare(`SELECT after_json FROM audit_log WHERE entity_id=? AND action='application.submitted'`)
      .bind(s.applicationId)
      .first<{ after_json: string }>();
    expect(audit!.after_json).not.toContain('203.0.113.10');
  });
});

// ---------------------------------------------------------------------------
describe('promotion actually lands where it claims', () => {
  it('writes organization and contact columns, not only application columns', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));

    const org = await db
      .prepare(`SELECT website, mission, annual_operating_budget_cents AS b FROM organizations WHERE id=?`)
      .bind(s.org.organizationId)
      .first<{ website: string; mission: string; b: number }>();
    expect(org?.website).toContain('example-bayoureach.org');
    expect(org?.mission).toBe('Literacy programs.');
    expect(org?.b).toBe(82_500_000);

    // marketing_opt_in is the single field that syncs to Eloqua and previously
    // never reached contacts at all.
    const contact = await db
      .prepare(`SELECT marketing_opt_in AS m, job_title FROM contacts WHERE organization_id=? AND email=?`)
      .bind(s.org.organizationId, 'director@example-bayoureach.org')
      .first<{ m: number; job_title: string }>();
    expect(contact?.m).toBe(1);
    expect(contact?.job_title).toBe('Executive Director');
  });

  it('records who submitted', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    const app = await db
      .prepare(`SELECT submitted_by_contact_id AS c FROM applications WHERE id=?`)
      .bind(s.applicationId)
      .first<{ c: string | null }>();
    expect(app?.c).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('search is scoped and lifecycle-aware', () => {
  it('refuses an external session', async () => {
    const s = await scenario();
    await expect(searchApplications(db, s.session, 'literacy')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('allows staff', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    const hits = await searchApplications(db, adminSession(), 'reading support');
    expect(hits.map((h) => h.application_id)).toContain(s.applicationId);
  });

  it('excludes soft-deleted applications', async () => {
    const s = await scenario();
    await submitApplication(db, s.ctx, s.session, s.applicationId, payload(s.atts));
    await db.prepare(`UPDATE applications SET deleted_at=datetime('now') WHERE id=?`).bind(s.applicationId).run();
    const hits = await searchApplications(db, adminSession(), 'reading support');
    expect(hits.map((h) => h.application_id)).not.toContain(s.applicationId);
  });
});

// ---------------------------------------------------------------------------
describe('scoping helpers', () => {
  it('assertOwnedByExternalSession rejects a foreign org and refuses internal roles', () => {
    const s = applicantSession('org-a');
    expect(() => assertOwnedByExternalSession(s, 'org-a')).not.toThrow();
    expect(() => assertOwnedByExternalSession(s, 'org-b')).toThrow();
    // Previously this returned silently for admin, reviewer AND executive --
    // and an executive is documented as having no in-app access at all.
    expect(() => assertOwnedByExternalSession(adminSession(), 'org-a')).toThrow();
    expect(() => assertOwnedByExternalSession(reviewerSession(), 'org-a')).toThrow();
  });

  it('hides soft-deleted applications from their own organization', async () => {
    const s = await scenario();
    await db.prepare(`UPDATE applications SET deleted_at=datetime('now') WHERE id=?`).bind(s.applicationId).run();
    await expect(getApplicationForExternal(db, s.session, s.applicationId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listApplicationsForExternal(db, s.session)).toHaveLength(0);
  });

  it('every applications column is classified as applicant-safe or internal', async () => {
    // The old guard compared two constants in the same file, so a NEWLY added
    // internal column was invisible to it. This reads the real table.
    const { results } = await db.prepare(`PRAGMA table_info(applications)`).all<{ name: string }>();
    const allow = new Set<string>(APPLICANT_APPLICATION_COLUMNS);
    const deny = new Set<string>(INTERNAL_ONLY_COLUMNS);
    const withheld = new Set(['deleted_at']);
    const unclassified = results
      .map((r) => r.name)
      .filter((c) => !allow.has(c) && !deny.has(c) && !withheld.has(c));
    expect(unclassified, `unclassified columns: ${unclassified.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('form engine robustness', () => {
  it('survives a circular conditional instead of blowing the stack', () => {
    const a: FieldDef = {
      id: 'a', field_key: 'a', label: 'A', help_text: null, field_type: 'short_text',
      is_required: false, sort_order: 0, options: [], validation: {},
      conditional_on_field_id: 'b', conditional_value: 'x', maps_to: null, section_id: 's',
    };
    const b: FieldDef = { ...a, id: 'b', field_key: 'b', label: 'B', conditional_on_field_id: 'a' };
    const byId = new Map([['a', a], ['b', b]]);
    expect(() => isFieldVisible(a, new Map(), byId)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('referential integrity across a program', () => {
  it('refuses an application whose stage and cycle belong to different programs', async () => {
    const ctx = ctxFor(adminSession());
    const a = await seedProgram(db, ctx, INSPIRE_CHANGE);
    const b = await seedProgram(db, ctx, { ...INSPIRE_CHANGE, slug: 'prog-b', name: 'Prog B' });
    const org = await seedOrganization(db, ctx, ORG_FIXTURES[0]!);

    await expect(
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
           VALUES (?,?,?,?,?,'draft',datetime('now'),datetime('now'))`,
        )
        .bind(newId(), Object.values(a.cycleIds)[0]!, b.stageIds.application!, org.organizationId, a.formDefinitionIds.application!)
        .run(),
    ).rejects.toThrow(/same program/);
  });

  it('enforces the program per-cycle application limit', async () => {
    const s = await scenario();
    await expect(
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, created_at, updated_at)
           VALUES (?,?,?,?,?,'draft',datetime('now'),datetime('now'))`,
        )
        .bind(newId(), s.cycleId, s.program.stageIds.application!, s.org.organizationId, s.program.formDefinitionIds.application!)
        .run(),
    ).rejects.toThrow(/application limit/);
  });
});

// ---------------------------------------------------------------------------
describe('schema invariants that previously had no test', () => {
  it('refuses a draft carrying a submitted_at', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, submitted_at, created_at, updated_at)
           VALUES ('d1','c','s','o','f','draft',datetime('now'),datetime('now'),datetime('now'))`,
        )
        .run(),
    ).rejects.toThrow(/CHECK|FOREIGN/i);
  });

  it('refuses an awarded application with no decision', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id, status, submitted_at, created_at, updated_at)
           VALUES ('d2','c','s','o','f','awarded',datetime('now'),datetime('now'),datetime('now'))`,
        )
        .run(),
    ).rejects.toThrow(/CHECK|FOREIGN/i);
  });

  it('refuses a cycle that closes before it opens', async () => {
    const p = await seedProgram(db, ctxFor(adminSession()), INSPIRE_CHANGE);
    await expect(
      db
        .prepare(
          `INSERT INTO cycles (id, program_id, name, opens_at, closes_at, status, created_at, updated_at)
           VALUES (?,?,'Bad','2026-05-01T00:00:00Z','2026-01-01T00:00:00Z','draft',datetime('now'),datetime('now'))`,
        )
        .bind(newId(), p.programId)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('refuses a merge into a soft-deleted organization', async () => {
    const ctx = ctxFor(adminSession());
    const a = await seedOrganization(db, ctx, ORG_FIXTURES[0]!);
    const b = await seedOrganization(db, ctx, ORG_FIXTURES[1]!);
    await db.prepare(`UPDATE organizations SET deleted_at=datetime('now') WHERE id=?`).bind(b.organizationId).run();
    await expect(
      db
        .prepare(`UPDATE organizations SET status='merged', merged_into_id=? WHERE id=?`)
        .bind(b.organizationId, a.organizationId)
        .run(),
    ).rejects.toThrow(/live, unmerged/);
  });
});
