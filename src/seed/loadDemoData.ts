/**
 * Load invented demo data into a database.
 *
 * THROUGH THE REAL CODE PATHS wherever it can be: organizations, contacts and
 * users come from resolveApplicantIdentity, answers go through the same
 * coercion and promotion a live submission uses. Demo data written straight
 * into columns would prove nothing about the system and would drift from it
 * silently -- the first thing it should catch is a promotion that stopped
 * working, and it cannot do that if it bypasses promotion.
 *
 * NEVER POINT THIS AT PRODUCTION. It is invented data, so it belongs in
 * preview. Real past applications go to staging (decision 18) and come from
 * the importer, not from here.
 */

import type { RequestContext } from '../types';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/time';
import { auditStatement } from '../lib/audit';
import { allFields, validateSubmission } from '../lib/forms';
import { loadFormDefinition } from '../lib/loadForm';
import { promote } from '../lib/mapsTo';
import { answerStatements } from '../lib/submit';
import { buildSearchDoc, reindexStatements } from '../lib/search';
import { resolveApplicantIdentity } from '../lib/identity';
import { buildDemoPlan, type DemoPlan } from './demoData';

export interface LoadResult {
  organizations: number;
  applications: number;
  skipped: { reason: string; count: number }[];
}

export async function loadDemoData(
  db: D1Database,
  ctx: RequestContext,
  opts: {
    /**
     * One or more cycles. MORE THAN ONE MATTERS: an organization may hold one
     * application per cycle, so a single-cycle load silently discards most of
     * what it generates and produces a database where nobody has applied
     * twice -- which is precisely the institutional memory the applicant
     * history panel exists to show.
     */
    cycleIds: string[];
    applicationFormId: string;
    plan?: DemoPlan;
    /** Wall-clock base for submitted_at, so a demo set has a plausible spread. */
    now?: Date;
  },
): Promise<LoadResult> {
  const plan = opts.plan ?? buildDemoPlan();
  const definition = await loadFormDefinition(db, opts.applicationFormId);
  const fields = allFields(definition);
  const now = opts.now ?? new Date();

  const skipped = new Map<string, number>();
  const note = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const identityByOrg = new Map<string, { organizationId: string; contactId: string }>();
  let applications = 0;

  if (opts.cycleIds.length === 0) throw new Error('loadDemoData needs at least one cycle');

  for (const [index, app] of plan.applications.entries()) {
    const org = app.organization;
    // Round-robin across cycles, so a repeat applicant lands in a different
    // one rather than colliding with itself.
    const cycleId = opts.cycleIds[index % opts.cycleIds.length]!;

    let identity = identityByOrg.get(org.id);
    if (!identity) {
      const resolved = await resolveApplicantIdentity(db, ctx, {
        ein: org.ein,
        legalName: org.legalName,
        email: org.email,
        firstName: org.firstName,
        lastName: org.lastName,
      });
      if (resolved.kind !== 'ready') {
        // The deliberate duplicate EIN resolves as ambiguous once BOTH rows
        // exist, which is the path working rather than failing. Counted and
        // reported instead of thrown, so a demo load is not derailed by the
        // very case it was built to create.
        note(resolved.kind);
        continue;
      }
      identity = { organizationId: resolved.organizationId, contactId: resolved.contactId };
      identityByOrg.set(org.id, identity);
    }

    // One application per organization per cycle, enforced by the database.
    const existing = await db
      .prepare(
        `SELECT 1 FROM applications
          WHERE cycle_id = ? AND organization_id = ? AND form_definition_id = ?
            AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(cycleId, identity.organizationId, opts.applicationFormId)
      .first();
    if (existing) {
      note('already_applied_this_cycle');
      continue;
    }

    // The two required uploads. Real objects do not exist -- presigned upload
    // is not built -- so these are METADATA ONLY: the row is real, the r2_key
    // points at nothing, and any download from a demo database will 404. That
    // is stated in the key itself rather than left to be discovered.
    const uploadAnswers: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.field_type !== 'file_upload') continue;
      const attachmentId = newId();
      const filename =
        field.field_key === 'financial_statements'
          ? 'financial-statements-2025.pdf'
          : 'operating-budget-2026.pdf';
      await db
        .prepare(
          `INSERT INTO attachments (id, parent_type, parent_id, organization_id,
             form_field_id, r2_key, filename, mime_type, size_bytes, uploaded_at)
           VALUES (?, 'application', NULL, ?, ?, ?, ?, 'application/pdf', ?, ?)`,
        )
        .bind(
          attachmentId,
          identity.organizationId,
          field.id,
          `demo/no-such-object/${attachmentId}`,
          filename,
          120_000,
          submittedAtFor(index, now),
        )
        .run();
      uploadAnswers[field.field_key] = [{ attachment_id: attachmentId, filename }];
    }

    const applicationId = newId();
    const outcome = validateSubmission(definition, { ...app.answers, ...uploadAnswers });
    if (outcome.errors.length > 0) {
      // Loud, not silent. Generated data that no longer validates means the
      // form definition moved and the generator did not -- exactly the drift
      // this file exists to surface.
      throw new Error(
        `demo application ${index} for ${org.legalName} does not validate: ` +
          outcome.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
      );
    }

    const promoted = promote(fields, outcome.answers);
    // The search index, which saveDraft deliberately does not touch and
    // submitApplication does. Without it a demo database has hundreds of
    // applications and a search box that finds none of them -- which would
    // make the one feature this data exists to exercise look broken.
    const searchDoc = buildSearchDoc({
      applicationId,
      definition,
      answers: outcome.answers,
      promoted: promoted.application as Record<string, string | number | null>,
    });
    const submittedAt = submittedAtFor(index, now);
    const stamp = nowIso();
    const decided = app.status === 'awarded' || app.status === 'declined';

    await db.batch([
      db
        .prepare(
          `INSERT INTO applications (id, cycle_id, stage_id, organization_id,
             form_definition_id, submitted_by_contact_id, status, created_at, updated_at)
           SELECT ?, ?, fd.stage_id, ?, fd.id, ?, 'draft', ?, ?
             FROM form_definitions fd WHERE fd.id = ?`,
        )
        .bind(
          applicationId, cycleId, identity.organizationId, identity.contactId,
          submittedAt, stamp, opts.applicationFormId,
        ),
      ...answerStatements(db, applicationId, definition, outcome.answers, submittedAt),
      db
        .prepare(
          `UPDATE applications
              SET status = ?, submitted_at = ?, updated_at = ?,
                  requested_amount_cents = ?, organization_name_at_submit = ?,
                  ein_at_submit = ?, primary_contact_email = ?, counties_served_json = ?,
                  project_title = ?,
                  decided_at = ?, decided_by = ?
            WHERE id = ? AND status = 'draft'`,
        )
        .bind(
          app.status,
          submittedAt,
          stamp,
          promoted.application.requested_amount_cents ?? null,
          promoted.application.organization_name_at_submit ?? org.legalName,
          promoted.application.ein_at_submit ?? org.ein,
          promoted.application.primary_contact_email ?? org.email,
          promoted.application.counties_served_json ?? null,
          promoted.application.project_title ?? null,
          decided ? submittedAt : null,
          decided ? await demoAdminId(db) : null,
          applicationId,
        ),
      ...reindexStatements(db, searchDoc, submittedAt),
      auditStatement(db, ctx, {
        action: 'application.submitted',
        entityType: 'application',
        entityId: applicationId,
        after: { status: app.status, source: 'demo_data', cycle_id: cycleId },
      }),
    ]);
    applications++;
  }

  return {
    organizations: identityByOrg.size,
    applications,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Spread submissions over the ninety days before `now`, so the pipeline has an
 * order and the history panel has something to show.
 */
function submittedAtFor(index: number, now: Date): string {
  return new Date(now.getTime() - (index % 90) * 86_400_000).toISOString();
}

/**
 * A staff user to attribute demo decisions to.
 *
 * The schema requires a decision to name who made it, so a decided demo
 * application needs one. Invented, and marked so in its address.
 */
let cachedAdminId: string | null = null;
async function demoAdminId(db: D1Database): Promise<string> {
  if (cachedAdminId) return cachedAdminId;
  const email = 'demo-reviewer@example-steward-demo.org';
  const found = await db
    .prepare(`SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`)
    .bind(email)
    .first<{ id: string }>();
  if (found) {
    cachedAdminId = found.id;
    return found.id;
  }
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, display_name, is_active,
         created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 'Demo Reviewer', 1, ?, ?)`,
    )
    .bind(id, email, now, now)
    .run();
  cachedAdminId = id;
  return id;
}

/** Test hook: the cached id is per-process and a fresh database needs a fresh one. */
export function __resetDemoAdminCache(): void {
  cachedAdminId = null;
}
