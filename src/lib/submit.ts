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
 *      Validate everything. Resolve attachment ownership. Compute promotion and
 *      the search document. Nothing is written. Any failure throws before a
 *      single row changes.
 *
 *   2. WRITE. One batch. EVERY statement in it carries the same guard -- the
 *      application must still be a draft -- and the flip to 'submitted' is the
 *      LAST statement. On the losing side of a concurrent double-submit every
 *      guard evaluates false, so the whole batch no-ops instead of overwriting
 *      the winner's answers with the loser's.
 *
 * Guarding only the final UPDATE was not enough: the answer upserts, the FTS
 * reindex and the audit row committed anyway, leaving the promoted money column
 * disagreeing with the answer row it came from, two 'submitted' audit rows, and
 * both callers told they had succeeded.
 *
 * The audit row is IN the batch, not after it, so it cannot drift from the
 * mutation it describes.
 */

import type { RequestContext, Session } from '../types';
import { AppError, notFound, validationFailed, type FieldError } from './errors';
import { auditStatement } from './audit';
import { validateSubmission, allFields, type FormDefinition } from './forms';
import { loadFormDefinition } from './loadForm';
import { promote } from './mapsTo';
import { buildSearchDoc, reindexStatements } from './search';
import { newId } from './ids';
import { nowIso, isCycleAcceptingSubmission } from './time';
import { sessionOrgId } from './scope';
import { assertCents } from './money';
import type { StoredValue } from './fieldTypes';
import { isStoredEmpty } from './fieldTypes';

/**
 * D1 caps bound parameters per statement (100 on the remote service; SQLite's
 * local limit is far higher, which is exactly how this passes in tests and
 * fails in production). Statements built from a form's shape are chunked.
 */
const MAX_BOUND_PARAMS = 90;

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

const APPLICATION_COLUMNS = `id, cycle_id, stage_id, organization_id, form_definition_id, status,
              submitted_at, created_at, project_title, requested_amount_cents,
              organization_name_at_submit, ein_at_submit, primary_contact_email,
              counties_served_json, guidelines_version`;

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
      `SELECT ${APPLICATION_COLUMNS}
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

/** Load the answers already stored, so autosave can judge conditional visibility. */
async function loadExistingAnswers(
  db: D1Database,
  applicationId: string,
): Promise<Map<string, StoredValue>> {
  const { results } = await db
    .prepare(
      `SELECT form_field_id, value_text, value_int, value_real, value_json
         FROM application_answers WHERE application_id = ?`,
    )
    .bind(applicationId)
    .all<{
      form_field_id: string;
      value_text: string | null;
      value_int: number | null;
      value_real: number | null;
      value_json: string | null;
    }>();

  const map = new Map<string, StoredValue>();
  for (const r of results ?? []) {
    map.set(r.form_field_id, {
      value_text: r.value_text,
      value_int: r.value_int,
      value_real: r.value_real,
      value_json: r.value_json,
    });
  }
  return map;
}

/**
 * Every mutating statement carries this guard. `EXISTS` is evaluated when the
 * statement runs, inside the batch's transaction, so a concurrent submit that
 * has already committed makes it false and the statement writes nothing.
 */
const DRAFT_GUARD = `EXISTS (SELECT 1 FROM applications WHERE id = ? AND status = 'draft' AND deleted_at IS NULL)`;

/** The same predicate, in the shape the audit and reindex helpers accept. */
function draftGuard(applicationId: string): { sql: string; binds: unknown[] } {
  return { sql: DRAFT_GUARD, binds: [applicationId] };
}

/** Build the guarded upsert statements for a set of coerced answers. */
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

    // A cleared answer is a DELETE, not an all-NULL row.
    //
    // Writing the row made "there is a row" and "there is an answer" different
    // things, and required-ness was reading the first as the second -- which
    // is how every required field except the attestations became defeatable by
    // answering it with "". forms.ts now judges the value rather than the row,
    // so this is the second of two independent defences; it also stops the
    // answers table filling with rows that mean nothing.
    if (isStoredEmpty(stored)) {
      stmts.push(
        db
          .prepare(
            `DELETE FROM application_answers
              WHERE application_id = ? AND form_field_id = ? AND ${DRAFT_GUARD}`,
          )
          .bind(applicationId, fieldId, applicationId),
      );
      continue;
    }

    // Last line of defence before a value reaches a money column. The database
    // CHECK cannot reject the STRING '2500007' -- SQLite's TEXT->INTEGER
    // affinity converts it before the CHECK runs -- so the type has to be
    // asserted here, at the binding site.
    if (field.field_type === 'currency' && stored.value_int !== null) {
      assertCents(stored.value_int, field.label);
    }

    stmts.push(
      db
        .prepare(
          `INSERT INTO application_answers (
             id, application_id, form_field_id, field_key, label_at_answer, field_type,
             value_text, value_int, value_real, value_json, answered_at
           )
           SELECT ?,?,?,?,?,?,?,?,?,?,?
            WHERE ${DRAFT_GUARD}
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
          applicationId, // guard
        ),
    );
  }
  return stmts;
}

/**
 * Clear answers for fields that are no longer visible.
 *
 * An applicant who selects "Other", types a detail, then changes their answer
 * must not ship the stale detail. `validateSubmission` only reports a field as
 * hidden when its parent actually participated in the request, so a partial
 * autosave can no longer delete answers it never saw.
 *
 * Chunked to stay under D1's bound-parameter ceiling.
 */
function clearHiddenStatements(
  db: D1Database,
  applicationId: string,
  hiddenFieldIds: readonly string[],
): D1PreparedStatement[] {
  if (hiddenFieldIds.length === 0) return [];
  const stmts: D1PreparedStatement[] = [];

  for (let i = 0; i < hiddenFieldIds.length; i += MAX_BOUND_PARAMS) {
    const chunk = hiddenFieldIds.slice(i, i + MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => '?').join(',');
    stmts.push(
      db
        .prepare(
          `DELETE FROM application_answers
            WHERE application_id = ?
              AND form_field_id IN (${placeholders})
              AND ${DRAFT_GUARD}`,
        )
        .bind(applicationId, ...chunk, applicationId),
    );
  }
  return stmts;
}

/**
 * Resolve the attachment ids an applicant claims, against attachments their own
 * organization owns.
 *
 * Without this the answer payload is trusted: a client can name ANY attachment
 * id, including one belonging to another nonprofit, and it is stored and later
 * resolved to a signed URL. That is the path that hands one organization's
 * audited financial statements to another.
 *
 * Returns the attachment ids to stamp with this application as their parent.
 */
async function resolveAttachments(
  db: D1Database,
  organizationId: string,
  applicationId: string,
  definition: FormDefinition,
  answers: ReadonlyMap<string, StoredValue>,
): Promise<{ ids: string[]; errors: FieldError[] }> {
  const errors: FieldError[] = [];
  const claimed: { fieldKey: string; label: string; attachmentId: string }[] = [];

  for (const field of allFields(definition)) {
    if (field.field_type !== 'file_upload') continue;
    const stored = answers.get(field.id);
    if (!stored?.value_json) continue;
    let refs: unknown;
    try {
      refs = JSON.parse(stored.value_json);
    } catch {
      continue;
    }
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      const id = (ref as { attachment_id?: unknown })?.attachment_id;
      if (typeof id === 'string') {
        claimed.push({ fieldKey: field.field_key, label: field.label, attachmentId: id });
      }
    }
  }

  if (claimed.length === 0) return { ids: [], errors };

  const owned = new Set<string>();
  const uniqueIds = [...new Set(claimed.map((c) => c.attachmentId))];
  for (let i = 0; i < uniqueIds.length; i += MAX_BOUND_PARAMS) {
    const chunk = uniqueIds.slice(i, i + MAX_BOUND_PARAMS);
    const { results } = await db
      .prepare(
        `SELECT id FROM attachments
          WHERE organization_id = ?
            AND deleted_at IS NULL
            AND (parent_id IS NULL OR parent_id = ?)
            AND id IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(organizationId, applicationId, ...chunk)
      .all<{ id: string }>();
    for (const r of results ?? []) owned.add(r.id);
  }

  for (const c of claimed) {
    if (!owned.has(c.attachmentId)) {
      errors.push({
        field: c.fieldKey,
        message: `${c.label} could not be verified. Please upload the file again.`,
      });
    }
  }

  return { ids: [...owned], errors };
}

/** Stamp resolved attachments with this application as their parent. */
function claimAttachmentStatements(
  db: D1Database,
  applicationId: string,
  attachmentIds: readonly string[],
): D1PreparedStatement[] {
  if (attachmentIds.length === 0) return [];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < attachmentIds.length; i += MAX_BOUND_PARAMS) {
    const chunk = attachmentIds.slice(i, i + MAX_BOUND_PARAMS);
    stmts.push(
      db
        .prepare(
          `UPDATE attachments
              SET parent_type = 'application', parent_id = ?
            WHERE id IN (${chunk.map(() => '?').join(',')})
              AND ${DRAFT_GUARD}`,
        )
        .bind(applicationId, ...chunk, applicationId),
    );
  }
  return stmts;
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
): Promise<{ savedAt: string; errors: FieldError[] }> {
  const app = await loadWritableApplication(db, session, applicationId);

  if (app.status !== 'draft') {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `saveDraft on application ${app.id} in status ${app.status}`,
      severity: 'warn',
    });
  }

  const definition = await loadFormDefinition(db, app.form_definition_id);
  const existingAnswers = await loadExistingAnswers(db, app.id);
  const outcome = validateSubmission(definition, raw, { partial: true, existingAnswers });

  const savedAt = nowIso();

  // Record what is being discarded, so a cleared answer is recoverable from the
  // audit trail rather than merely counted.
  const clearedBefore: Record<string, unknown> = {};
  for (const fieldId of outcome.hiddenFieldIds) {
    const prior = existingAnswers.get(fieldId);
    if (prior) clearedBefore[fieldId] = prior;
  }

  const statements = [
    ...answerStatements(db, app.id, definition, outcome.answers, savedAt),
    ...clearHiddenStatements(db, app.id, outcome.hiddenFieldIds),
    auditStatement(
      db,
      ctx,
      {
        action: 'application.answer_saved',
        entityType: 'application',
        entityId: app.id,
        before: Object.keys(clearedBefore).length > 0 ? { cleared_answers: clearedBefore } : null,
        after: {
          status: 'draft',
          saved_field_keys: [...outcome.answers.keys()]
            .map((id) => allFields(definition).find((f) => f.id === id)?.field_key)
            .filter(Boolean),
          cleared_field_ids: outcome.hiddenFieldIds,
          had_validation_errors: outcome.errors.length > 0,
        },
      },
      // THE SAME GUARD as every other statement in this batch.
      //
      // It was missing. Every answer upsert and every clear carried
      // DRAFT_GUARD; the audit row did not, and the return value was computed
      // without reading the batch result at all. So an autosave racing a
      // concurrent submit wrote NO answers, told the applicant "Saved at
      // 19:41", and left an append-only row asserting an event that never
      // happened. submitApplication, forty lines below, already did this
      // correctly -- the rule was written down here and then not applied here.
      { guard: draftGuard(app.id) },
    ),
    // LAST, so its row count is the authoritative answer about whether this
    // call actually did anything. Same construction as submitApplication.
    db
      .prepare(
        `UPDATE applications SET updated_at = ?
          WHERE id = ? AND status = 'draft' AND deleted_at IS NULL`,
      )
      .bind(savedAt, app.id),
  ];

  const results = await db.batch(statements);

  // The confirmation must prove MY write landed, not that SOME write did.
  // 0 means the draft guard was already false: a concurrent submit won, or an
  // admin moved the application on. Telling the applicant it saved would be a
  // false green light on the one screen where losing work matters most.
  const changed = results[results.length - 1]?.meta?.changes ?? 0;
  if (changed !== 1) {
    throw new AppError('CONFLICT', 'This application is no longer a draft. Reload to see its current state.', {
      internalMessage: `autosave for ${app.id} affected ${changed} rows; the draft guard was false`,
      severity: 'warn',
    });
  }

  return { savedAt, errors: outcome.errors };
}

export interface SubmitResult {
  applicationId: string;
  submittedAt: string;
}

/**
 * Pick the promoted value for a column, distinguishing "this form does not
 * promote here" from "the applicant cleared it".
 *
 * `??` could not tell those apart, so a blank optional currency answer
 * resurrected whatever amount happened to be on the row -- a stored,
 * award-relevant figure with no answer behind it.
 */
function promotedOr<T>(
  promoted: Record<string, string | number | null>,
  column: string,
  fallback: T,
): string | number | null | T {
  return Object.prototype.hasOwnProperty.call(promoted, column) ? promoted[column]! : fallback;
}

/**
 * Submit an application.
 *
 * Validates the WHOLE definition, not just the last section touched, then
 * writes everything in one atomic, fully guarded batch.
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
    status: cycle.status,
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
        context: { reason: window.reason, cycleId: cycle.id, cycleStatus: cycle.status },
      },
    );
  }

  const definition = await loadFormDefinition(db, app.form_definition_id);
  // Only a PUBLISHED definition may receive a submission. A retired one was
  // previously accepted, which meant an applicant could submit against a form
  // that had been superseded.
  if (definition.status !== 'published') {
    throw new AppError('CONFLICT', 'This form is not open for submissions.', {
      internalMessage: `submit against ${definition.status} form definition ${definition.id}`,
      severity: 'error',
    });
  }

  const existingAnswers = await loadExistingAnswers(db, app.id);
  const outcome = validateSubmission(definition, raw, { existingAnswers });

  const attachments = await resolveAttachments(
    db,
    app.organization_id,
    app.id,
    definition,
    outcome.answers,
  );

  const allErrors = [...outcome.errors, ...attachments.errors];
  if (allErrors.length > 0) throw validationFailed(allErrors);

  const promoted = promote(allFields(definition), outcome.answers);
  const searchDoc = buildSearchDoc({
    applicationId: app.id,
    definition,
    answers: outcome.answers,
    promoted: promoted.application,
  });

  // Who signed this. Resolved from the promoted contact email where the form
  // collects one, falling back to the organization's primary contact.
  const contactEmail = promoted.application.primary_contact_email;
  const submittedByContact = await db
    .prepare(
      `SELECT id FROM contacts
        WHERE organization_id = ? AND deleted_at IS NULL
          AND (email = ? OR ? IS NULL)
        ORDER BY (email = ?) DESC, is_primary DESC
        LIMIT 1`,
    )
    .bind(app.organization_id, contactEmail, contactEmail, contactEmail)
    .first<{ id: string }>();

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
    project_title: promotedOr(promoted.application, 'project_title', app.project_title),
    requested_amount_cents: promotedOr(
      promoted.application,
      'requested_amount_cents',
      app.requested_amount_cents,
    ),
    organization_name_at_submit: promotedOr(
      promoted.application,
      'organization_name_at_submit',
      app.organization_name_at_submit,
    ),
    ein_at_submit: promotedOr(promoted.application, 'ein_at_submit', app.ein_at_submit),
    primary_contact_email: promotedOr(
      promoted.application,
      'primary_contact_email',
      app.primary_contact_email,
    ),
    counties_served_json: promotedOr(
      promoted.application,
      'counties_served_json',
      app.counties_served_json,
    ),
    guidelines_version: opts.guidelinesVersion ?? app.guidelines_version,
  };

  if (typeof after.requested_amount_cents === 'number') {
    assertCents(after.requested_amount_cents, 'requested amount');
  }

  // ---------------------------------------------------------------------------
  // Half 2: one atomic batch, every statement guarded, the status flip LAST.
  // ---------------------------------------------------------------------------
  const guard = draftGuard(app.id);

  const statements: D1PreparedStatement[] = [
    ...answerStatements(db, app.id, definition, outcome.answers, submittedAt),
    ...clearHiddenStatements(db, app.id, outcome.hiddenFieldIds),
    ...claimAttachmentStatements(db, app.id, attachments.ids),
    ...reindexStatements(db, searchDoc, submittedAt, guard),
    ...organizationPromotionStatements(db, ctx, app.organization_id, promoted.organization, guard),
    ...contactPromotionStatements(db, ctx, app.organization_id, contactEmail, promoted.contact, guard),

    // Guarded like everything else: the losing side of a race must not leave an
    // audit row asserting a submission that never happened.
    auditStatement(db, ctx, {
      action: 'application.submitted',
      entityType: 'application',
      entityId: app.id,
      before,
      after,
    }, { guard }),

    // LAST. Everything above is a no-op if this would be.
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
        submittedByContact?.id ?? null,
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
  ];

  const results = await db.batch(statements);

  // The confirmation must prove MY write landed, not that SOME write did.
  //
  // The status flip is the LAST statement by construction, so its row count is
  // the authoritative answer: 1 means this call performed the submit, 0 means
  // the guard was already false and a concurrent submit won.
  //
  // Comparing `submitted_at` instead is not sufficient -- two submits in the
  // same millisecond produce identical timestamps, and the loser then mistakes
  // the winner's row for its own. Row count has no clock resolution to lose.
  const updateResult = results[results.length - 1];
  const changed = updateResult?.meta?.changes ?? 0;

  if (changed !== 1) {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `submit for ${app.id} affected ${changed} rows; a concurrent submit won`,
      severity: 'warn',
    });
  }

  // Belt and braces: the row really is submitted now.
  const confirmed = await db
    .prepare(`SELECT status FROM applications WHERE id = ?`)
    .bind(app.id)
    .first<{ status: string }>();

  if (confirmed?.status !== 'submitted') {
    throw new AppError('CONFLICT', 'This application could not be submitted.', {
      internalMessage: `submit for ${app.id} reported a row change but status is ${confirmed?.status}`,
      severity: 'error',
    });
  }

  return { applicationId: app.id, submittedAt };
}

/**
 * Write promoted organization fields.
 *
 * These targets (website, mission, operating budget, and crucially EIN) were
 * declared in the promotion map, accepted at publish, and written nowhere --
 * which meant `organizations.ein` never updated and the EIN-match-at-submit
 * deduplication had no data behind it.
 */
function organizationPromotionStatements(
  db: D1Database,
  ctx: RequestContext,
  organizationId: string,
  values: Record<string, string | number | null>,
  guard: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  const columns = Object.keys(values).filter((c) => values[c] !== null);
  if (columns.length === 0) return [];

  const assignments = columns.map((c) => `${c} = ?`).join(', ');
  return [
    db
      .prepare(
        `UPDATE organizations SET ${assignments}, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND ${guard.sql}`,
      )
      .bind(...columns.map((c) => values[c]!), nowIso(), organizationId, ...guard.binds),
    auditStatement(db, ctx, {
      action: 'organization.updated',
      entityType: 'organization',
      entityId: organizationId,
      after: { promoted_from_application: columns },
    }, { guard }),
  ];
}

/**
 * Write promoted contact fields, including marketing_opt_in -- the single field
 * that syncs to Eloqua, and which previously never reached `contacts` at all.
 */
function contactPromotionStatements(
  db: D1Database,
  ctx: RequestContext,
  organizationId: string,
  contactEmail: string | number | null | undefined,
  values: Record<string, string | number | null>,
  guard: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  if (typeof contactEmail !== 'string' || contactEmail === '') return [];
  const columns = Object.keys(values).filter((c) => c !== 'email' && values[c] !== null);
  if (columns.length === 0) return [];

  const assignments = columns.map((c) => `${c} = ?`).join(', ');
  return [
    db
      .prepare(
        `UPDATE contacts SET ${assignments}, updated_at = ?
          WHERE organization_id = ? AND email = ? AND deleted_at IS NULL AND ${guard.sql}`,
      )
      .bind(...columns.map((c) => values[c]!), nowIso(), organizationId, contactEmail, ...guard.binds),
    auditStatement(db, ctx, {
      action: 'contact.updated',
      entityType: 'contact',
      entityId: `${organizationId}:${contactEmail}`,
      after: { promoted_from_application: columns },
    }, { guard }),
  ];
}
