/**
 * Draft save and application submit.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE:
 *
 * D1 has no interactive transactions. There is no BEGIN, read, branch, write,
 * COMMIT over HTTP. The only atomic unit is `db.batch()`, which executes a
 * PRECOMPUTED list of statements as a single transaction.
 *
 * So submit is structured in two distinct halves:
 *
 *   1. READ AND DECIDE. Load the definition, the application, and the cycle.
 *      Validate everything. Compute promotion and the search document. Nothing
 *      is written. Any failure here throws before a single row changes.
 *
 *   2. WRITE. One batch containing the application update, every answer upsert,
 *      the cleared hidden answers, the promoted columns, the FTS document, and
 *      the audit row. Either all of it lands or none of it does.
 *
 * The audit row is IN the batch, not after it. That is what makes "every write
 * produces an audit row" survive a failure halfway through.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound, validationFailed } from './errors';
import { auditStatement } from './audit';
import { loadFormDefinition, validateSubmission, allFields, type FormDefinition } from './forms';
import { promote } from './mapsTo';
import { buildSearchDoc, reindexStatements } from './search';
import { newId } from './ids';
import { nowIso, isCycleAcceptingSubmission } from './time';
import { sessionOrgId } from './scope';
import type { StoredValue } from './fieldTypes';

interface ApplicationRow {
  id: string;
  cycle_id: string;
  stage_id: string;
  organization_id: string;
  form_definition_id: string;
  status: string;
  submitted_at: string | null;
  created_at: string;
  project_title: string | null;
  requested_amount_cents: number | null;
  organization_name_at_submit: string | null;
  ein_at_submit: string | null;
  primary_contact_email: string | null;
  counties_served_json: string | null;
  guidelines_version: string | null;
}

interface CycleRow {
  id: string;
  opens_at: string;
  closes_at: string;
  status: string;
  draft_grace_hours: number;
}

/**
 * Load an application the session is allowed to write to.
 *
 * Scoped by the session's organization id in SQL. An id from the URL can only
 * ever narrow this query, never widen it, and a miss is a 404.
 */
async function loadWritableApplication(
  db: D1Database,
  session: Session,
  applicationId: string,
): Promise<ApplicationRow> {
  const orgId = sessionOrgId(session);
  const row = await db
    .prepare(
      `SELECT id, cycle_id, stage_id, organization_id, form_definition_id, status,
              submitted_at, created_at, project_title, requested_amount_cents,
              organization_name_at_submit, ein_at_submit, primary_contact_email,
              counties_served_json, guidelines_version
         FROM applications
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(applicationId, orgId)
    .first<ApplicationRow>();

  if (!row) throw notFound('application');
  return row;
}

async function loadCycle(db: D1Database, cycleId: string): Promise<CycleRow> {
  const cycle = await db
    .prepare(
      `SELECT id, opens_at, closes_at, status, draft_grace_hours
         FROM cycles WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(cycleId)
    .first<CycleRow>();
  if (!cycle) throw notFound('cycle');
  return cycle;
}

/** Build the upsert statements for a set of coerced answers. */
function answerStatements(
  db: D1Database,
  applicationId: string,
  definition: FormDefinition,
  answers: ReadonlyMap<string, StoredValue>,
  answeredAt: string,
): D1PreparedStatement[] {
  const fieldsById = new Map(allFields(definition).map((f) => [f.id, f]));
  const stmts: D1PreparedStatement[] = [];

  for (const [fieldId, stored] of answers) {
    const field = fieldsById.get(fieldId);
    if (!field) continue;

    stmts.push(
      db
        .prepare(
          `INSERT INTO application_answers (
             id, application_id, form_field_id, field_key, label_at_answer, field_type,
             value_text, value_int, value_real, value_json, answered_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(application_id, form_field_id) DO UPDATE SET
             value_text  = excluded.value_text,
             value_int   = excluded.value_int,
             value_real  = excluded.value_real,
             value_json  = excluded.value_json,
             answered_at = excluded.answered_at`,
        )
        .bind(
          newId(),
          applicationId,
          fieldId,
          field.field_key,
          field.label,
          field.field_type,
          stored.value_text,
          stored.value_int,
          stored.value_real,
          stored.value_json,
          answeredAt,
        ),
    );
  }
  return stmts;
}

/**
 * Clear answers for fields that are no longer visible.
 *
 * An applicant who selects "Other", types a detail, then changes their answer
 * must not ship the stale detail. Deleting the row is correct here and is not a
 * hard-delete of a financial record: a draft answer to a hidden question is not
 * a record, and the audit row captures that it happened.
 */
function clearHiddenStatements(
  db: D1Database,
  applicationId: string,
  hiddenFieldIds: readonly string[],
): D1PreparedStatement[] {
  if (hiddenFieldIds.length === 0) return [];
  const placeholders = hiddenFieldIds.map(() => '?').join(',');
  return [
    db
      .prepare(
        `DELETE FROM application_answers
          WHERE application_id = ? AND form_field_id IN (${placeholders})`,
      )
      .bind(applicationId, ...hiddenFieldIds),
  ];
}

/**
 * Autosave a partial draft.
 *
 * Partial validation: a half-finished form is a draft, not an error. Type
 * errors still surface (a letter in a currency field is worth telling someone
 * about immediately), but required-ness is a submit-time concern.
 *
 * Deliberately does NOT touch the search index. See migration 0005.
 */
export async function saveDraft(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  raw: Record<string, unknown>,
): Promise<{ savedAt: string; errors: ReturnType<typeof validateSubmission>['errors'] }> {
  const app = await loadWritableApplication(db, session, applicationId);

  if (app.status !== 'draft') {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `saveDraft on application ${app.id} in status ${app.status}`,
      severity: 'warn',
    });
  }

  const definition = await loadFormDefinition(db, app.form_definition_id);
  const outcome = validateSubmission(definition, raw, { partial: true });

  const savedAt = nowIso();
  const statements = [
    ...answerStatements(db, app.id, definition, outcome.answers, savedAt),
    ...clearHiddenStatements(db, app.id, outcome.hiddenFieldIds),
    db
      .prepare(`UPDATE applications SET updated_at = ? WHERE id = ?`)
      .bind(savedAt, app.id),
    auditStatement(db, ctx, {
      action: 'application.answer_saved',
      entityType: 'application',
      entityId: app.id,
      after: {
        saved_field_keys: [...outcome.answers.keys()].length,
        cleared_field_count: outcome.hiddenFieldIds.length,
        status: 'draft',
      },
    }),
  ];

  await db.batch(statements);
  return { savedAt, errors: outcome.errors };
}

export interface SubmitResult {
  applicationId: string;
  submittedAt: string;
}

/**
 * Submit an application.
 *
 * Validates the WHOLE definition, not just the last section touched, then
 * writes everything in one atomic batch.
 */
export async function submitApplication(
  db: D1Database,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  raw: Record<string, unknown>,
  opts: { guidelinesVersion?: string | null } = {},
): Promise<SubmitResult> {
  // ---------------------------------------------------------------------------
  // Half 1: read and decide. Nothing is written in this half.
  // ---------------------------------------------------------------------------
  const app = await loadWritableApplication(db, session, applicationId);

  if (app.status !== 'draft') {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `submit on application ${app.id} already in status ${app.status}`,
      severity: 'warn',
    });
  }

  const cycle = await loadCycle(db, app.cycle_id);
  const window = isCycleAcceptingSubmission({
    opensAt: cycle.opens_at,
    closesAt: cycle.closes_at,
    graceHours: cycle.draft_grace_hours,
    draftStartedAt: app.created_at,
  });

  if (!window.accepted) {
    throw new AppError(
      'CYCLE_CLOSED',
      window.reason === 'not_yet_open'
        ? 'This cycle is not open for submissions yet.'
        : 'This cycle has closed. Your draft has been saved and staff can still see it.',
      {
        internalMessage: `submit rejected for application ${app.id}: ${window.reason}`,
        severity: 'warn',
        context: { reason: window.reason, cycleId: cycle.id },
      },
    );
  }

  const definition = await loadFormDefinition(db, app.form_definition_id);
  if (definition.status === 'draft') {
    throw new AppError('CONFLICT', 'This form is not open for submissions yet.', {
      internalMessage: `submit against unpublished form definition ${definition.id}`,
      severity: 'error',
    });
  }

  const outcome = validateSubmission(definition, raw);
  if (outcome.errors.length > 0) {
    throw validationFailed(outcome.errors);
  }

  const promoted = promote(allFields(definition), outcome.answers);
  const searchDoc = buildSearchDoc({
    applicationId: app.id,
    definition,
    answers: outcome.answers,
    promoted: promoted.application,
  });

  const submittedAt = nowIso();

  const before = {
    status: app.status,
    submitted_at: app.submitted_at,
    project_title: app.project_title,
    requested_amount_cents: app.requested_amount_cents,
    organization_name_at_submit: app.organization_name_at_submit,
    ein_at_submit: app.ein_at_submit,
    primary_contact_email: app.primary_contact_email,
    counties_served_json: app.counties_served_json,
    guidelines_version: app.guidelines_version,
  };

  const after = {
    status: 'submitted',
    submitted_at: submittedAt,
    project_title: promoted.application.project_title ?? app.project_title,
    requested_amount_cents:
      promoted.application.requested_amount_cents ?? app.requested_amount_cents,
    organization_name_at_submit:
      promoted.application.organization_name_at_submit ?? app.organization_name_at_submit,
    ein_at_submit: promoted.application.ein_at_submit ?? app.ein_at_submit,
    primary_contact_email:
      promoted.application.primary_contact_email ?? app.primary_contact_email,
    counties_served_json:
      promoted.application.counties_served_json ?? app.counties_served_json,
    guidelines_version: opts.guidelinesVersion ?? app.guidelines_version,
  };

  // ---------------------------------------------------------------------------
  // Half 2: one atomic batch. Application, answers, promotion, search, audit.
  // ---------------------------------------------------------------------------
  const statements: D1PreparedStatement[] = [
    ...answerStatements(db, app.id, definition, outcome.answers, submittedAt),
    ...clearHiddenStatements(db, app.id, outcome.hiddenFieldIds),

    db
      .prepare(
        `UPDATE applications
            SET status = 'submitted',
                submitted_at = ?,
                submitted_by_contact_id = COALESCE(submitted_by_contact_id, ?),
                guidelines_version = ?,
                project_title = ?,
                requested_amount_cents = ?,
                organization_name_at_submit = ?,
                ein_at_submit = ?,
                primary_contact_email = ?,
                counties_served_json = ?,
                submission_ip = ?,
                submission_user_agent = ?,
                updated_at = ?
          WHERE id = ?
            AND organization_id = ?
            AND status = 'draft'`,
      )
      .bind(
        submittedAt,
        null,
        after.guidelines_version,
        after.project_title,
        after.requested_amount_cents,
        after.organization_name_at_submit,
        after.ein_at_submit,
        after.primary_contact_email,
        after.counties_served_json,
        ctx.ip,
        ctx.userAgent,
        submittedAt,
        app.id,
        app.organization_id,
      ),

    ...reindexStatements(db, searchDoc, submittedAt),

    auditStatement(db, ctx, {
      action: 'application.submitted',
      entityType: 'application',
      entityId: app.id,
      before,
      after,
    }),
  ];

  await db.batch(statements);

  // The UPDATE carries `AND status = 'draft'`, so a concurrent double-submit
  // updates zero rows on the loser. D1 does not error on a zero-row UPDATE and
  // the batch still reports success, so the only honest confirmation is to read
  // the row back. Two admins on one record is last-write-wins everywhere else
  // in this system; submit is the one place we refuse to guess.
  const confirmed = await db
    .prepare(`SELECT status, submitted_at FROM applications WHERE id = ?`)
    .bind(app.id)
    .first<{ status: string; submitted_at: string | null }>();

  if (!confirmed || confirmed.status !== 'submitted') {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `submit for ${app.id} did not take effect; status is ${confirmed?.status}`,
      severity: 'error',
    });
  }

  return { applicationId: app.id, submittedAt };
}
