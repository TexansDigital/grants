/**
 * Direct-to-R2 uploads.
 *
 * THE PATTERN, FROM CLAUDE.MD, LEARNED THE HARD WAY. Deviating from any of
 * these produces a failure that does not reproduce in curl:
 *
 *   1. The browser PUTs straight to R2 with a presigned URL. The Worker only
 *      authorizes. File bodies never pass through it -- the edge request body
 *      limit rejects a large upload BEFORE the handler runs, so a Worker that
 *      proxies the file fails on exactly the files people care about.
 *   2. aws4fetch, not the AWS SDK. The SDK wants Node APIs Workers lack.
 *   3. DO NOT SIGN Content-Type, and the browser must not send it. With
 *      `signQuery: true` only the host header is signed; any extra header the
 *      browser adds produces a 403 that is invisible from the command line.
 *      R2 records the correct content type regardless.
 *   4. PUT, not an HTML form POST. R2 presigned URLs do not support POST.
 *
 * A presigned URL is a bearer token. One object, one operation, short expiry.
 */

import { AwsClient } from 'aws4fetch';
import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { newId } from './ids';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { allFields } from './forms';
import { loadFormDefinition } from './loadForm';
import { validateUploadIntent } from './fieldTypes';
import { loadGranteePeriod, isPeriodFileable } from './reportSubmit';

/**
 * Ten minutes.
 *
 * Long enough for a slow connection to push 8 MB, short enough that a URL
 * pasted into a chat is useless by the time anyone reads it.
 */
export const PRESIGN_TTL_SECONDS = 600;

export interface UploadIntent {
  fieldKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface PresignedUpload {
  attachmentId: string;
  uploadUrl: string;
  expiresAt: string;
  /**
   * Headers the browser must send. Deliberately EMPTY -- see rule 3. Returned
   * as an explicit empty object rather than omitted, so a client author sees
   * the answer to "what headers do I send" instead of guessing.
   */
  headers: Record<string, string>;
}

/**
 * The signing client, shared by the upload and download paths.
 *
 * Exported so downloads.ts signs with the same credentials and the same
 * library. Two copies of "how do we talk to R2" is how one of them ends up
 * using the AWS SDK, or signing a header it must not sign.
 */
export function r2Client(env: Env): AwsClient {
  const id = (env.R2_ACCESS_KEY_ID ?? '').trim();
  const secret = (env.R2_SECRET_ACCESS_KEY ?? '').trim();
  if (!id || !secret) {
    throw new AppError('INTERNAL', 'File uploads are not available right now.', {
      internalMessage: 'R2 signing credentials are not configured',
      severity: 'error',
    });
  }
  return new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: 's3', region: 'auto' });
}

/**
 * The object key.
 *
 * Scoped by organization so an accidental listing is at least bounded by
 * tenant, and the id is random rather than derived from the filename: an
 * applicant's filename can contain their organization's name, a beneficiary's
 * name, or anything else, and object keys turn up in logs.
 */
export function objectKey(organizationId: string, attachmentId: string): string {
  return `org/${organizationId}/${attachmentId}`;
}

/**
 * Authorize one upload against one form field, record it, and hand back a URL.
 *
 * The attachment row is created BEFORE the browser uploads, with parent_id
 * null: a file exists from the moment the PUT finishes, which is before there
 * is an application or a report submission to attach it to. organization_id is
 * what makes it attributable in the meantime, and what the submit paths check
 * a claimed attachment against.
 *
 * SHARED BY APPLICATIONS AND GRANTEE REPORTS. Reports upload through the same
 * presigned-PUT path and must obey the same rules; two copies would mean the
 * four rules at the top of this file being followed in one of them, and the
 * upload credential is not a thing to have two versions of. The CALLERS decide
 * what may be uploaded to and when -- that is the part that genuinely differs.
 */
/**
 * The origin every presigned upload is sent to.
 *
 * ONE definition, because two places must agree about it: the signer below,
 * and the page's Content-Security-Policy. They did not agree. The CSP said
 * `connect-src 'self'` and nothing more, so the browser refused the
 * cross-origin PUT before making it -- no request, no R2 error, no Worker log,
 * just a console line on a page nobody was watching. Uploads could not have
 * worked in production for any applicant or grantee.
 *
 * It was invisible to the test suite because the applicant browser harness
 * drives Vite's dev server, which serves no CSP at all. The policy exists only
 * on responses this Worker writes.
 */
export function r2Origin(bucket: string, accountId: string): string {
  return `https://${bucket}.${accountId}.r2.cloudflarestorage.com`;
}

/**
 * That origin for the CSP, or null when uploads are not configured.
 *
 * Null rather than a guess: with no bucket or account id there is nothing to
 * allow, and a policy naming a half-built origin is worse than one that allows
 * nothing, because it looks deliberate.
 */
export function r2UploadOrigin(env: Env): string | null {
  const bucket = (env.R2_BUCKET_NAME ?? '').trim();
  const accountId = (env.R2_ACCOUNT_ID ?? '').trim();
  if (!bucket || !accountId) return null;
  return r2Origin(bucket, accountId);
}

async function presignForField(
  env: Env,
  ctx: RequestContext,
  session: Session,
  opts: {
    organizationId: string;
    formDefinitionId: string;
    parentType: 'application' | 'report_submission';
    /** Named on the audit row so an upload is traceable to what it was for. */
    auditContext: Record<string, unknown>;
  },
  intent: UploadIntent,
): Promise<PresignedUpload> {
  const { organizationId, formDefinitionId, parentType } = opts;
  const definition = await loadFormDefinition(env.DB, formDefinitionId);
  const field = allFields(definition).find((f) => f.field_key === intent.fieldKey);
  if (!field || field.field_type !== 'file_upload') {
    throw new AppError('VALIDATION_FAILED', 'That is not a field you can upload a file to.', {
      internalMessage: `field ${intent.fieldKey} is not a file_upload on ${formDefinitionId}`,
      severity: 'warn',
    });
  }

  // Server-side, against the field's own rules. The browser checks the same
  // things for a fast message; this is the one that counts, because a client
  // check is a convenience and the presigned URL is a credential.
  //
  // NOTE what this is NOT: R2 does no malware scanning, and a declared MIME
  // type is a claim by the uploader rather than a fact about the bytes. Type
  // and size validation is not safety. Files are served only as downloads,
  // never rendered inline.
  const check = validateUploadIntent(field, intent);
  if (!check.ok) {
    throw new AppError('VALIDATION_FAILED', check.message, {
      internalMessage: `upload intent rejected: ${check.message}`,
      severity: 'warn',
    });
  }

  const bucket = (env.R2_BUCKET_NAME ?? '').trim();
  const accountId = (env.R2_ACCOUNT_ID ?? '').trim();
  if (!bucket || !accountId) {
    throw new AppError('INTERNAL', 'File uploads are not available right now.', {
      internalMessage: 'R2_BUCKET_NAME or R2_ACCOUNT_ID is not configured',
      severity: 'error',
    });
  }

  const attachmentId = newId();
  const key = objectKey(organizationId, attachmentId);
  const now = nowIso();

  const client = r2Client(env);
  const endpoint = `${r2Origin(bucket, accountId)}/${key}`;
  const signed = await client.sign(
    new Request(`${endpoint}?X-Amz-Expires=${PRESIGN_TTL_SECONDS}`, { method: 'PUT' }),
    {
      aws: {
        // Puts the signature in the query string, which is what makes a plain
        // PUT from a browser work at all -- and what limits the signature to
        // the host header. See rule 3.
        signQuery: true,
      },
    },
  );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, form_field_id,
         r2_key, filename, mime_type, size_bytes, uploaded_by, uploaded_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      attachmentId, parentType,
      organizationId, field.id, key,
      intent.filename, intent.mimeType, intent.sizeBytes, session.userId, now,
    ),
    auditStatement(env.DB, ctx, {
      action: 'attachment.uploaded',
      entityType: 'attachment',
      entityId: attachmentId,
      after: {
        organization_id: organizationId,
        field_key: intent.fieldKey,
        filename: intent.filename,
        size_bytes: intent.sizeBytes,
        // The r2_key is recorded on the row; it is not repeated into the audit
        // snapshot, which is read by more people than need an object path.
        ...opts.auditContext,
      },
    }),
  ]);

  return {
    attachmentId,
    uploadUrl: signed.url,
    expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
    headers: {},
  };
}

/**
 * An applicant uploading to their own draft application.
 *
 * Scoped read: another organization's application is a 404, and a submitted
 * application cannot take new files.
 */
export async function presignUpload(
  env: Env,
  ctx: RequestContext,
  session: Session,
  applicationId: string,
  intent: UploadIntent,
): Promise<PresignedUpload> {
  const organizationId = session.organizationId;
  if (!organizationId) {
    throw new AppError('FORBIDDEN', 'This account is not linked to an organization.', {
      internalMessage: 'presignUpload reached with no organization on the session',
      severity: 'error',
    });
  }

  const app = await env.DB.prepare(
    `SELECT id, status, form_definition_id FROM applications
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
  )
    .bind(applicationId, organizationId)
    .first<{ id: string; status: string; form_definition_id: string }>();
  if (!app) throw notFound('application');
  if (app.status !== 'draft') {
    throw new AppError('CONFLICT', 'This application has already been submitted.', {
      internalMessage: `upload requested for application ${applicationId} in status ${app.status}`,
      severity: 'warn',
    });
  }

  return presignForField(
    env, ctx, session,
    {
      organizationId,
      formDefinitionId: app.form_definition_id,
      parentType: 'application',
      auditContext: { application_id: applicationId },
    },
    intent,
  );
}

/**
 * A grantee uploading to a report they are still working on.
 *
 * Same two questions as the applicant path, answered against the award rather
 * than the application: is this period reachable from an award this session's
 * organization holds, and is it still open to file. `loadGranteePeriod` does
 * the first in SQL, so an id in the URL can only narrow the query.
 */
export async function presignReportUpload(
  env: Env,
  ctx: RequestContext,
  session: Session,
  reportPeriodId: string,
  intent: UploadIntent,
): Promise<PresignedUpload> {
  const period = await loadGranteePeriod(env.DB, session, reportPeriodId);
  if (!isPeriodFileable(period)) {
    throw new AppError('CONFLICT', 'This report is no longer open.', {
      internalMessage: `upload requested for report period ${reportPeriodId} in status ${period.status}`,
      severity: 'warn',
    });
  }
  if (!period.form_definition_id) {
    throw new AppError('CONFLICT', 'This report form is not ready yet. We will be in touch.', {
      internalMessage: `upload requested for report period ${reportPeriodId} with no form`,
      severity: 'error',
    });
  }

  return presignForField(
    env, ctx, session,
    {
      organizationId: period.organization_id,
      formDefinitionId: period.form_definition_id,
      parentType: 'report_submission',
      auditContext: { report_period_id: reportPeriodId, award_id: period.award_id },
    },
    intent,
  );
}
