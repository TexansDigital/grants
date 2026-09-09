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

function r2Client(env: Env): AwsClient {
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
 * Authorize one upload, record it, and hand back a URL.
 *
 * The attachment row is created BEFORE the browser uploads, with parent_id
 * null: a file exists from the moment the PUT finishes, which is before there
 * is an application to attach it to. organization_id is what makes it
 * attributable in the meantime, and what submit.ts checks a claimed
 * attachment against.
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

  // Scoped read. Another organization's application is 404, and a submitted
  // one cannot take new files.
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

  const definition = await loadFormDefinition(env.DB, app.form_definition_id);
  const field = allFields(definition).find((f) => f.field_key === intent.fieldKey);
  if (!field || field.field_type !== 'file_upload') {
    throw new AppError('VALIDATION_FAILED', 'That is not a field you can upload a file to.', {
      internalMessage: `field ${intent.fieldKey} is not a file_upload on ${app.form_definition_id}`,
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
  const endpoint = `https://${bucket}.${accountId}.r2.cloudflarestorage.com/${key}`;
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
       VALUES (?, 'application', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      attachmentId, organizationId, field.id, key,
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
        application_id: applicationId,
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
