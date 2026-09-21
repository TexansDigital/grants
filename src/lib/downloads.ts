/**
 * Issuing a credential to fetch one uploaded file.
 *
 * WHY THIS EXISTS AT ALL. Steward could take an audited financial statement
 * from a nonprofit and could not give it back to the person reviewing the
 * application. Uploads have worked since Phase 2; nothing has ever read one.
 *
 * THE SHAPE MIRRORS THE UPLOAD PATH, and for the same reasons (see uploads.ts):
 * the bytes go straight between the browser and R2, and this Worker only
 * signs. A Worker that streamed the file would fail on exactly the large
 * documents that matter, and would put third-party financial statements
 * through a request path that has no business holding them.
 *
 * WHAT A SIGNED URL IS. A bearer token: whoever holds the string can fetch
 * that one object until it expires, with no further authentication. Everything
 * here follows from that -- one object, one operation, five minutes, and an
 * audit row naming who asked, because after the URL leaves this function the
 * only record that it was ever issued is the one written here.
 *
 * WHAT THIS IS NOT. It is not a scan. R2 does no malware scanning and a
 * declared MIME type is a claim by the uploader rather than a fact about the
 * bytes. The response is forced to download rather than render, which stops a
 * hostile HTML or SVG upload executing on this system's origin; it does not
 * make the file safe to open.
 */

import type { Env, RequestContext, Session } from '../types';
import { AppError, notFound } from './errors';
import { nowIso } from './time';
import { auditStatement } from './audit';
import { r2Client, r2UploadOrigin } from './uploads';
import { staffApplicationScope, sessionOrgId } from './scope';

/**
 * Five minutes.
 *
 * Shorter than the ten an upload gets, because the two are not symmetrical. An
 * upload URL has to survive a slow nonprofit connection pushing 8 MB; a
 * download URL only has to survive the moment between the click and the
 * browser starting the transfer. R2 checks expiry when the request arrives, so
 * a download already in flight is unaffected by the window closing.
 *
 * The cost of a longer window is entirely one-sided: a URL pasted into a chat,
 * a ticket, or a browser history is a live handle on somebody's audited
 * accounts for as long as it lasts.
 */
export const DOWNLOAD_TTL_SECONDS = 300;

export interface DownloadGrant {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** The signed URL. Treat as a credential: it needs no further auth. */
  url: string;
  expiresAt: string;
}

interface AttachmentRow {
  id: string;
  parent_type: string;
  parent_id: string | null;
  organization_id: string | null;
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

/**
 * `Content-Disposition`, built so the browser saves rather than renders.
 *
 * Two filename forms, because one is not enough. The quoted `filename` is
 * ASCII and is what every client understands; `filename*` carries the real
 * name for clients that implement RFC 5987, which is how a nonprofit whose
 * budget is called "Presupuesto anual.pdf" gets that name back.
 *
 * THE ESCAPING IS THE POINT. An applicant chooses this string. A filename
 * containing a double quote closes the quoted form early and everything after
 * it becomes header syntax, which is a header injection into a response served
 * by R2 rather than by us -- so the ASCII form keeps only printable characters
 * and no quote or backslash survives it.
 */
export function contentDisposition(filename: string): string {
  const ascii =
    // eslint-disable-next-line no-control-regex
    filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\;]/g, '_').trim() || 'download';
  // encodeURIComponent leaves !'()* alone, and RFC 5987's attr-char excludes
  // all of them. Percent-encode them by hand rather than hoping no filename
  // ever contains an apostrophe -- plenty do.
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Is this attachment one this staff session may read?
 *
 * ADMIN IS NOT THE DEFAULT ANSWER; it is the answer for parent types that only
 * an admin ever touches. The case that carries real weight is a reviewer, who
 * may open a file only through an application assigned to them -- decided in
 * SQL against `review_assignments`, the same table scope.ts reads, rather than
 * by a role check here. Two places deciding who may see an application is one
 * place too many.
 *
 * An UNCLAIMED attachment (parent_id null) belongs to nobody's application
 * yet. It is admin-only, because the only legitimate reason to open one is an
 * admin looking at what an abandoned or suspicious upload actually was.
 */
async function assertStaffMayRead(
  db: D1Database,
  session: Session,
  row: AttachmentRow,
): Promise<void> {
  if (row.parent_type === 'application' && row.parent_id) {
    const scope = staffApplicationScope(session);
    const seen = await db
      .prepare(
        `SELECT 1 AS n FROM applications a ${scope.join}
          WHERE ${scope.where} AND a.id = ? AND a.deleted_at IS NULL
          LIMIT 1`,
      )
      .bind(...scope.binds, row.parent_id)
      .first<{ n: number }>();
    // 404, never 403: a reviewer probing ids learns nothing about which
    // applications exist.
    if (!seen) throw notFound('file');
    return;
  }

  // Reports, awards, organizations, rubrics, programs, and anything not yet
  // claimed. A reviewer's remit is the applications assigned to them and
  // nothing else, so everything here is the admin's.
  if (session.role !== 'admin') throw notFound('file');
}

/**
 * Sign exactly one GET of one object.
 *
 * ONE COPY, used by both callers. CLAUDE.md's R2 rules are labelled "learned
 * the hard way, do not deviate", and the way a rule like that gets deviated
 * from is a second signer written six months later that omits one line of it.
 * The staff path and the external path differ in who may ask and in what gets
 * recorded -- never in how the URL is built.
 */
async function signOneRead(env: Env, row: AttachmentRow): Promise<string> {
  const origin = r2UploadOrigin(env);
  if (!origin) {
    throw new AppError('INTERNAL', 'File downloads are not available right now.', {
      internalMessage: 'R2_BUCKET_NAME or R2_ACCOUNT_ID is not configured',
      severity: 'error',
    });
  }

  const query = new URLSearchParams({
    'X-Amz-Expires': String(DOWNLOAD_TTL_SECONDS),
    'response-content-disposition': contentDisposition(row.filename),
    // Overrides whatever content type R2 recorded from the upload. The stored
    // type is the uploader's claim; serving every file as an opaque stream
    // means a mislabelled -- or deliberately labelled -- HTML or SVG document
    // cannot be talked into rendering.
    'response-content-type': 'application/octet-stream',
  });

  const signed = await r2Client(env).sign(
    new Request(`${origin}/${row.r2_key}?${query.toString()}`, { method: 'GET' }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

/**
 * Authorize one read of one file, record it, and hand back a URL.
 *
 * The counters and the audit row are written in the SAME batch as each other
 * and BEFORE the URL is returned. D1 has no interactive transaction, so the
 * ordering that matters is this: if the write fails, the caller gets an error
 * and no URL. There is no path on which a credential is issued without a
 * record of issuing it.
 */
export async function presignDownloadForStaff(
  env: Env,
  ctx: RequestContext,
  session: Session,
  attachmentId: string,
): Promise<DownloadGrant> {
  const row = await env.DB.prepare(
    `SELECT id, parent_type, parent_id, organization_id, r2_key, filename,
            mime_type, size_bytes, purged_at
       FROM attachments WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(attachmentId)
    .first<AttachmentRow & { purged_at: string | null }>();
  if (!row) throw notFound('file');

  await assertStaffMayRead(env.DB, session, row);

  /*
   * Retention may already have destroyed the bytes.
   *
   * The row survives a purge on purpose -- what was uploaded, by whom, when,
   * and when it was destroyed is a financial record -- so this is the one case
   * where the attachment exists and the file does not. Checked AFTER the
   * access check, so a purge does not become a way of learning that an
   * attachment id was real.
   *
   * Said plainly rather than signing a URL that 404s at R2, which would read
   * to the person clicking as a broken system rather than a policy working.
   */
  if (row.purged_at) {
    throw new AppError('CONFLICT', 'This file was deleted under the retention policy.', {
      internalMessage: `download requested for attachment ${attachmentId} purged at ${row.purged_at}`,
      severity: 'warn',
    });
  }

  const url = await signOneRead(env, row);

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE attachments
          SET download_url_first_issued_at = COALESCE(download_url_first_issued_at, ?),
              download_url_last_issued_at  = ?,
              download_url_issue_count     = download_url_issue_count + 1
        WHERE id = ? AND deleted_at IS NULL`,
    ).bind(now, now, attachmentId),
    auditStatement(env.DB, ctx, {
      action: 'attachment.download_url_issued',
      entityType: 'attachment',
      entityId: attachmentId,
      after: {
        parent_type: row.parent_type,
        parent_id: row.parent_id,
        organization_id: row.organization_id,
        filename: row.filename,
        expires_in_seconds: DOWNLOAD_TTL_SECONDS,
      },
    }),
  ]);

  return {
    attachmentId,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    url,
    expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The applicant's and the grantee's own files
// ---------------------------------------------------------------------------

/**
 * Parent types an external user may ever reach a file through.
 *
 * AN ALLOWLIST, and a short one. `rubric` and `program` are staff artifacts --
 * a rubric's source spreadsheet is the scoring instrument, and an applicant
 * holding it before a decision is a different system from this one. Their
 * `organization_id` would not match a nonprofit's anyway; the list is here so
 * that a future parent type is admitted deliberately rather than by inheriting
 * a check somebody wrote for something else.
 */
const EXTERNAL_READABLE_PARENTS = new Set([
  'application',
  'report_submission',
  // The signed agreement, the W-9, the media release: uploaded BY the grantee.
  // A grantee who cannot re-read what they countersigned has to ask staff for
  // their own document back.
  'award',
  'organization',
]);

/**
 * Does this attachment belong to the session's organization, in both places?
 *
 * TWO CHECKS, NOT ONE, and deliberately redundant.
 *
 *   1. `attachments.organization_id` matches the session's organization. This
 *      is the column 0004 added for exactly this purpose and it is what makes
 *      an UNCLAIMED upload -- one with no parent yet -- attributable at all.
 *   2. The parent row, where there is one, also belongs to that organization.
 *
 * Either alone would be a correct check today. Together they mean a single
 * mis-stamped `organization_id` -- a bad import, a merge that moved
 * applications and not attachments, a hand-written repair -- hands somebody
 * another nonprofit's audited accounts only if BOTH are wrong in the same
 * direction. This is the read path for third-party financial statements; one
 * column is not enough to stand on.
 *
 * 404 throughout, never 403. An applicant walking attachment ids learns
 * nothing about which ones exist.
 */
async function assertExternalMayRead(
  db: D1Database,
  session: Session,
  row: AttachmentRow,
): Promise<void> {
  const orgId = sessionOrgId(session);

  if (!EXTERNAL_READABLE_PARENTS.has(row.parent_type)) throw notFound('file');
  if (row.organization_id !== orgId) throw notFound('file');

  if (row.parent_id === null) {
    /*
     * An unclaimed upload, which is the normal state between the browser's
     * presigned PUT and the moment the application is submitted. Its
     * organization_id is the only thing tying it to anybody, and it matched.
     * Letting this through is what makes "see what I attached" work on a draft
     * -- the case an applicant meets first.
     */
    return;
  }

  // The parent's own organization, by parent type. Written out rather than
  // built from a string, because a table name assembled from `parent_type`
  // is a query whose shape depends on a column value.
  let sql: string;
  switch (row.parent_type) {
    case 'application':
      sql = `SELECT 1 AS n FROM applications
              WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`;
      break;
    case 'report_submission':
      sql = `SELECT 1 AS n FROM report_submissions rs
               JOIN report_periods rp ON rp.id = rs.report_period_id
               JOIN awards w          ON w.id = rp.award_id
              WHERE rs.id = ? AND w.organization_id = ?
                AND rs.deleted_at IS NULL AND rp.deleted_at IS NULL
                AND w.deleted_at IS NULL`;
      break;
    case 'award':
      sql = `SELECT 1 AS n FROM awards
              WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`;
      break;
    default:
      sql = `SELECT 1 AS n FROM organizations
              WHERE id = ? AND id = ? AND deleted_at IS NULL`;
      break;
  }

  const seen = await db.prepare(sql).bind(row.parent_id, orgId).first<{ n: number }>();
  if (!seen) throw notFound('file');
}

/**
 * Authorize one read of one of the session organization's own files.
 *
 * WHY THIS EXISTS. A nonprofit uploads its audited financial statements, its
 * operating budget and an itemized spending budget in order to be considered,
 * and until now could never look at them again -- not to check the right file
 * went up, not to confirm what was sent, not after submitting. The review
 * screen showed filenames and nothing would open. A grantee filing a report
 * had the same gap on their own attachments.
 *
 * IT DOES NOT TOUCH THE RETENTION COUNTERS, and that is the subtle part.
 * `download_url_first_issued_at` drives one column on the retention screen:
 * "Asked for". That column answers "has anybody at the Foundation taken a copy
 * before we destroy this", and an applicant fetching their own document says
 * nothing whatever about that. Stamping it here would mark a file as retrieved
 * and silence the nightly warning, and the file would be destroyed with no
 * copy anywhere. The audit row is still written: it is the record that a
 * credential was issued, and it carries the actor and their role.
 */
export async function presignDownloadForExternal(
  env: Env,
  ctx: RequestContext,
  session: Session,
  attachmentId: string,
): Promise<DownloadGrant> {
  const row = await env.DB.prepare(
    `SELECT id, parent_type, parent_id, organization_id, r2_key, filename,
            mime_type, size_bytes, purged_at
       FROM attachments WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(attachmentId)
    .first<AttachmentRow & { purged_at: string | null }>();
  if (!row) throw notFound('file');

  await assertExternalMayRead(env.DB, session, row);

  if (row.purged_at) {
    /*
     * Worded for the person who uploaded it. "The retention policy" is the
     * Foundation's word for its own rule; what an applicant needs to know is
     * that their document is gone from here and that their own copy is the
     * one that exists now.
     */
    throw new AppError(
      'CONFLICT',
      'This file is no longer held here. Uploaded documents are deleted a set time after a decision.',
      {
        internalMessage: `external download for attachment ${attachmentId} purged at ${row.purged_at}`,
        severity: 'warn',
      },
    );
  }

  const url = await signOneRead(env, row);

  await env.DB.batch([
    auditStatement(env.DB, ctx, {
      action: 'attachment.download_url_issued',
      entityType: 'attachment',
      entityId: attachmentId,
      after: {
        parent_type: row.parent_type,
        parent_id: row.parent_id,
        organization_id: row.organization_id,
        filename: row.filename,
        expires_in_seconds: DOWNLOAD_TTL_SECONDS,
        // Said in the row itself, so a query of this action can separate the
        // two paths without joining to the actor's role at the time.
        issued_to: 'external',
      },
    }),
  ]);

  return {
    attachmentId,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    url,
    expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
  };
}
