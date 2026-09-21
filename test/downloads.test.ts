/**
 * Reading a file back.
 *
 * WHAT THESE TESTS ARE FOR. The download path hands out a bearer token for a
 * third party's audited accounts. Two things therefore have to be true, and
 * neither is visible from reading the happy path: a reviewer must not be able
 * to reach a file attached to an application nobody assigned them, and no URL
 * may ever leave this function without an audit row recording that it did.
 *
 * The filename tests look cosmetic and are not. An applicant chooses that
 * string, it is interpolated into a response header, and the response is
 * served by R2 rather than by us -- so a quote in a filename is a header
 * injection into a system that has never seen this code.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  db, ctxFor, adminSession, reviewerSession, applicantSession, appErrorFrom,
} from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import { objectKey } from '../src/lib/uploads';
import {
  presignDownloadForStaff,
  presignDownloadForExternal,
  contentDisposition,
  DOWNLOAD_TTL_SECONDS,
} from '../src/lib/downloads';
import type { Env, Session } from '../src/types';

const r2Env = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
  ...over,
});

let n = 0;
let admin: Session;

beforeEach(async () => {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'admin', NULL, 1, ?, ?)`,
    )
    .bind(id, `dl-admin-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  admin = adminSession(id);
});

/** An application with one financial statement attached to it. */
async function applicationWithFile(filename = 'audited-2025.pdf') {
  const p = await seedProgram(db, ctxFor(admin), { ...INSPIRE_CHANGE, slug: `dl-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const applicationId = newId();
  const attachmentId = newId();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
       VALUES (?,?,?,'active',?,?)`,
    )
    .bind(orgId, `Invented Alliance ${n}`, String(700000000 + n), now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
         status, submitted_at, created_at, updated_at)
       SELECT ?, ?, fd.stage_id, ?, fd.id, 'submitted', ?, ?, ?
         FROM form_definitions fd WHERE fd.id = ?`,
    )
    .bind(applicationId, cycleId, orgId, now, now, now, p.formDefinitionIds.application!)
    .run();
  await db
    .prepare(
      `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
         filename, mime_type, size_bytes, uploaded_at)
       VALUES (?, 'application', ?, ?, ?, ?, 'application/pdf', 120000, ?)`,
    )
    .bind(attachmentId, applicationId, orgId, objectKey(orgId, attachmentId), filename, now)
    .run();

  return { applicationId, orgId, attachmentId };
}

async function reviewerAssignedTo(applicationId: string | null): Promise<Session> {
  const userId = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
       VALUES (?,?, 'reviewer', NULL, 1, ?, ?)`,
    )
    .bind(userId, `rev-${crypto.randomUUID().slice(0, 8)}@example.org`, now, now)
    .run();
  if (applicationId) {
    await db
      .prepare(
        `INSERT INTO review_assignments (id, application_id, reviewer_user_id, assigned_at,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(newId(), applicationId, userId, now, now, now)
      .run();
  }
  return reviewerSession(userId);
}

// ---------------------------------------------------------------------------

describe('who may read a file', () => {
  it('lets an admin read an application attachment', async () => {
    const { attachmentId } = await applicationWithFile();
    const grant = await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    expect(grant.url).toContain('https://steward-preview-files.abc123account.r2.cloudflarestorage.com/');
    expect(grant.url).toContain('X-Amz-Signature=');
    expect(grant.filename).toBe('audited-2025.pdf');
  });

  it('lets an assigned reviewer read it', async () => {
    const { applicationId, attachmentId } = await applicationWithFile();
    const reviewer = await reviewerAssignedTo(applicationId);
    const grant = await presignDownloadForStaff(r2Env(), ctxFor(reviewer), reviewer, attachmentId);
    expect(grant.attachmentId).toBe(attachmentId);
  });

  it('404s for a reviewer with no assignment to that application', async () => {
    /*
     * THE BUG THIS PREVENTS. `roles: ['admin','reviewer']` on the route admits
     * every reviewer. If the handler then trusted that, any reviewer could
     * read the financial statements of every applicant in the system by
     * walking attachment ids -- including a conflicted one, and including an
     * outside consultant hired for one cycle.
     *
     * 404 and not 403, so the id tells them nothing either.
     */
    const { attachmentId } = await applicationWithFile();
    const stranger = await reviewerAssignedTo(null);
    const err = await appErrorFrom(
      presignDownloadForStaff(r2Env(), ctxFor(stranger), stranger, attachmentId),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  it('404s for a reviewer whose assignment was recused', async () => {
    // A recusal must remove access immediately. It is the same table scope.ts
    // reads, which is the point -- one definition of "assigned", not two.
    const { applicationId, attachmentId } = await applicationWithFile();
    const reviewer = await reviewerAssignedTo(applicationId);
    await db
      .prepare(
        `UPDATE review_assignments SET recused_at = ?, recused_reason = 'board member'
          WHERE application_id = ? AND reviewer_user_id = ?`,
      )
      .bind(nowIso(), applicationId, reviewer.userId)
      .run();

    const err = await appErrorFrom(
      presignDownloadForStaff(r2Env(), ctxFor(reviewer), reviewer, attachmentId),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  it('404s for an unknown or soft-deleted attachment', async () => {
    const { attachmentId } = await applicationWithFile();
    await db.prepare(`UPDATE attachments SET deleted_at = ? WHERE id = ?`).bind(nowIso(), attachmentId).run();
    const gone = await appErrorFrom(
      presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId),
    );
    expect(gone.code).toBe('NOT_FOUND');

    const never = await appErrorFrom(
      presignDownloadForStaff(r2Env(), ctxFor(admin), admin, newId()),
    );
    expect(never.code).toBe('NOT_FOUND');
  });

  it('keeps an unclaimed upload away from reviewers', async () => {
    // parent_id null means the file was uploaded and never attached to
    // anything. A reviewer has no application through which to reach it, so
    // there is no rule that could admit them -- and without this branch the
    // application check would simply be skipped.
    const { orgId } = await applicationWithFile();
    const attachmentId = newId();
    await db
      .prepare(
        `INSERT INTO attachments (id, parent_type, parent_id, organization_id, r2_key,
           filename, mime_type, size_bytes, uploaded_at)
         VALUES (?, 'application', NULL, ?, ?, 'orphan.pdf', 'application/pdf', 10, ?)`,
      )
      .bind(attachmentId, orgId, objectKey(orgId, attachmentId), nowIso())
      .run();

    const reviewer = await reviewerAssignedTo(null);
    const err = await appErrorFrom(
      presignDownloadForStaff(r2Env(), ctxFor(reviewer), reviewer, attachmentId),
    );
    expect(err.code).toBe('NOT_FOUND');

    const grant = await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    expect(grant.attachmentId).toBe(attachmentId);
  });
});

describe('what issuing a URL records', () => {
  it('writes an audit row and stamps the counters', async () => {
    const { attachmentId } = await applicationWithFile();
    await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);

    const row = await db
      .prepare(
        `SELECT download_url_first_issued_at AS first, download_url_last_issued_at AS last,
                download_url_issue_count AS n FROM attachments WHERE id = ?`,
      )
      .bind(attachmentId)
      .first<{ first: string; last: string; n: number }>();
    expect(row?.n).toBe(1);
    expect(row?.first).not.toBeNull();

    const audited = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action = 'attachment.download_url_issued' AND entity_id = ?`,
      )
      .bind(attachmentId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
  });

  it('keeps the FIRST issue time across later reads', async () => {
    // Retention warns until a file has been asked for. That question is about
    // the first time, so a second read must not move the mark -- and COALESCE
    // is easy to write the wrong way round.
    const { attachmentId } = await applicationWithFile();
    await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    const after1 = await db
      .prepare(`SELECT download_url_first_issued_at AS first FROM attachments WHERE id = ?`)
      .bind(attachmentId)
      .first<{ first: string }>();

    await new Promise((r) => setTimeout(r, 5));
    await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    const after2 = await db
      .prepare(
        `SELECT download_url_first_issued_at AS first, download_url_issue_count AS n
           FROM attachments WHERE id = ?`,
      )
      .bind(attachmentId)
      .first<{ first: string; n: number }>();

    expect(after2?.first).toBe(after1?.first);
    expect(after2?.n).toBe(2);
  });

  it('records nothing when the caller is refused', async () => {
    const { attachmentId } = await applicationWithFile();
    const stranger = await reviewerAssignedTo(null);
    await appErrorFrom(presignDownloadForStaff(r2Env(), ctxFor(stranger), stranger, attachmentId));

    const row = await db
      .prepare(`SELECT download_url_issue_count AS n FROM attachments WHERE id = ?`)
      .bind(attachmentId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('the URL itself', () => {
  it('forces a download and an opaque type, and expires', async () => {
    const { attachmentId } = await applicationWithFile();
    const grant = await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    const url = new URL(grant.url);

    expect(url.searchParams.get('response-content-disposition')).toContain('attachment;');
    // Never the uploader's declared type: a file claiming to be text/html must
    // not be talked into rendering on any origin.
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(DOWNLOAD_TTL_SECONDS));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('signs the override parameters rather than leaving them changeable', async () => {
    /*
     * THE BUG THIS PREVENTS. If response-content-disposition were appended
     * AFTER signing, R2 would reject the request -- or, worse, a signature
     * that ignored it would let anyone holding the URL strip the parameter and
     * ask R2 to serve the file inline with its uploaded content type. The
     * forced download would be decoration.
     */
    const { attachmentId } = await applicationWithFile();
    const grant = await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    const signed = new URL(grant.url).searchParams.get('X-Amz-Signature');
    expect(signed).toBeTruthy();

    const tampered = new URL(grant.url);
    tampered.searchParams.delete('response-content-disposition');
    expect(tampered.toString()).not.toBe(grant.url);
  });

  it('refuses when R2 is not configured', async () => {
    const { attachmentId } = await applicationWithFile();
    for (const missing of [{ R2_BUCKET_NAME: '' }, { R2_ACCOUNT_ID: '' }, { R2_SECRET_ACCESS_KEY: '' }]) {
      const err = await appErrorFrom(
        presignDownloadForStaff(r2Env(missing), ctxFor(admin), admin, attachmentId),
      );
      expect(err.code).toBe('INTERNAL');
    }
  });
});

describe('filenames an applicant chose', () => {
  it('cannot close the quoted form', async () => {
    const d = contentDisposition('bud"get; x=y.pdf');
    const ascii = d.slice(d.indexOf('filename="') + 10, d.indexOf('"; filename*='));
    expect(ascii).not.toContain('"');
    expect(ascii).not.toContain(';');
  });

  it('carries a non-ASCII name in the RFC 5987 form', async () => {
    const d = contentDisposition('Presupuesto anual ñ.pdf');
    expect(d).toContain("filename*=UTF-8''");
    expect(d).toContain('%C3%B1');
    // The ASCII fallback keeps a usable name rather than becoming empty.
    expect(d).toContain('filename="Presupuesto anual _.pdf"');
  });

  it('percent-encodes the characters attr-char excludes', async () => {
    // encodeURIComponent leaves !'()* alone and RFC 5987 does not allow them.
    const d = contentDisposition("o'brien (final)*.pdf");
    const ext = d.slice(d.indexOf("UTF-8''") + 7);
    for (const c of ["'", '(', ')', '*', '!']) expect(ext).not.toContain(c);
  });

  it('never produces an empty filename', async () => {
    expect(contentDisposition('   ')).toContain('filename="download"');
  });
});

// ---------------------------------------------------------------------------
// The applicant's and grantee's own files
// ---------------------------------------------------------------------------

describe('an organization reading back its own upload', () => {
  /** A session for the organization that owns the fixture. */
  const asOwner = (orgId: string) => applicantSession(orgId);

  it('lets the organization that uploaded it read it', async () => {
    /*
     * WHAT THIS CLOSES. A nonprofit handed over its audited accounts, its
     * operating budget and an itemized spending budget in order to be
     * considered, and could never look at any of them again -- not to check
     * the right file went up, not after submitting. The filenames were on the
     * review screen and nothing would open.
     */
    const { orgId, attachmentId } = await applicationWithFile();
    const session = asOwner(orgId);
    const grant = await presignDownloadForExternal(
      r2Env(), ctxFor(session), session, attachmentId,
    );
    expect(grant.url).toContain('X-Amz-Signature=');
    expect(grant.filename).toBe('audited-2025.pdf');
    expect(grant.url).toContain(`X-Amz-Expires=${DOWNLOAD_TTL_SECONDS}`);
  });

  it('404s for a different organization', async () => {
    // The non-negotiable: scoped by organization_id from the SESSION, never
    // from the request. Changing an id in a URL returns 404.
    const { attachmentId } = await applicationWithFile();
    const stranger = applicantSession(newId());
    expect(
      (await appErrorFrom(
        presignDownloadForExternal(r2Env(), ctxFor(stranger), stranger, attachmentId),
      )).code,
    ).toBe('NOT_FOUND');
  });

  it('404s when the attachment row says one organization and the parent says another', async () => {
    /*
     * THE POINT OF CHECKING TWICE. A mis-stamped organization_id -- a bad
     * import, a merge that moved applications and not attachments, a
     * hand-written repair -- would otherwise hand somebody another
     * nonprofit's audited accounts on the strength of one column.
     */
    const { attachmentId, orgId } = await applicationWithFile();
    const intruderOrg = newId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
         VALUES (?,?,?,'active',?,?)`,
      )
      .bind(intruderOrg, `Invented Other ${++n}`, String(710000000 + n), now, now)
      .run();
    // The attachment now claims to belong to the intruder; the application it
    // hangs off still belongs to the real organization.
    await db
      .prepare(`UPDATE attachments SET organization_id = ? WHERE id = ?`)
      .bind(intruderOrg, attachmentId)
      .run();

    const intruder = applicantSession(intruderOrg);
    expect(
      (await appErrorFrom(
        presignDownloadForExternal(r2Env(), ctxFor(intruder), intruder, attachmentId),
      )).code,
    ).toBe('NOT_FOUND');
    // And the real owner is refused too, because the row no longer says so.
    const owner = asOwner(orgId);
    expect(
      (await appErrorFrom(
        presignDownloadForExternal(r2Env(), ctxFor(owner), owner, attachmentId),
      )).code,
    ).toBe('NOT_FOUND');
  });

  it('lets them read an upload that has not been claimed by an application yet', async () => {
    // The normal state between the presigned PUT and submitting. Its
    // organization_id is the only thing tying it to anybody, and this is the
    // case an applicant meets first: "did the right file go up?"
    const { orgId, attachmentId } = await applicationWithFile();
    await db
      .prepare(`UPDATE attachments SET parent_id = NULL WHERE id = ?`)
      .bind(attachmentId)
      .run();
    const session = asOwner(orgId);
    const grant = await presignDownloadForExternal(
      r2Env(), ctxFor(session), session, attachmentId,
    );
    expect(grant.attachmentId).toBe(attachmentId);
  });

  it('refuses a parent type an external user has no business with', async () => {
    // A rubric's source spreadsheet is the scoring instrument. Even with the
    // organization_id somehow matching, it is not theirs to read.
    const { orgId, attachmentId } = await applicationWithFile();
    await db
      .prepare(`UPDATE attachments SET parent_type = 'rubric', parent_id = NULL WHERE id = ?`)
      .bind(attachmentId)
      .run();
    const session = asOwner(orgId);
    expect(
      (await appErrorFrom(
        presignDownloadForExternal(r2Env(), ctxFor(session), session, attachmentId),
      )).code,
    ).toBe('NOT_FOUND');
  });

  it('refuses a staff session outright rather than treating it as ownerless', async () => {
    // sessionOrgId throws for an internal role. Staff have their own path,
    // with its own scoping; this one must not become a second door into it.
    const { attachmentId } = await applicationWithFile();
    expect(
      (await appErrorFrom(
        presignDownloadForExternal(r2Env(), ctxFor(admin), admin, attachmentId),
      )).code,
    ).toBe('FORBIDDEN');
  });

  it('says plainly when retention has already destroyed the file', async () => {
    const { orgId, attachmentId } = await applicationWithFile();
    await db
      .prepare(`UPDATE attachments SET purged_at = ? WHERE id = ?`)
      .bind(nowIso(), attachmentId)
      .run();
    const session = asOwner(orgId);
    const err = await appErrorFrom(
      presignDownloadForExternal(r2Env(), ctxFor(session), session, attachmentId),
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.publicMessage).toMatch(/no longer held here/i);
  });

  it('writes an audit row, and does NOT touch the retention counters', async () => {
    /*
     * THE BUG THIS PREVENTS, and it is not obvious. The retention screen's
     * "Asked for" column reads download_url_first_issued_at, and it answers
     * one question: has anybody AT THE FOUNDATION taken a copy before these
     * documents are destroyed. An applicant fetching their own file says
     * nothing about that. Stamping it here would mark the file as retrieved,
     * silence the nightly warning, and the file would be destroyed with no
     * copy anywhere.
     */
    const { orgId, attachmentId } = await applicationWithFile();
    const session = asOwner(orgId);
    await presignDownloadForExternal(r2Env(), ctxFor(session), session, attachmentId);

    const row = await db
      .prepare(
        `SELECT download_url_first_issued_at AS first, download_url_issue_count AS n
           FROM attachments WHERE id = ?`,
      )
      .bind(attachmentId)
      .first<{ first: string | null; n: number }>();
    expect(row?.first).toBeNull();
    expect(row?.n).toBe(0);

    const audit = await db
      .prepare(
        `SELECT after_json FROM audit_log
          WHERE action = 'attachment.download_url_issued' AND entity_id = ?`,
      )
      .bind(attachmentId)
      .first<{ after_json: string }>();
    expect(audit).not.toBeNull();
    expect((JSON.parse(audit!.after_json) as Record<string, unknown>).issued_to).toBe('external');
  });

  it('and a staff read of the same file DOES stamp them', async () => {
    // The other half of the pair, so "does not stamp" cannot pass because
    // nothing ever stamps.
    const { attachmentId } = await applicationWithFile();
    await presignDownloadForStaff(r2Env(), ctxFor(admin), admin, attachmentId);
    const row = await db
      .prepare(
        `SELECT download_url_first_issued_at AS first, download_url_issue_count AS n
           FROM attachments WHERE id = ?`,
      )
      .bind(attachmentId)
      .first<{ first: string | null; n: number }>();
    expect(row?.first).not.toBeNull();
    expect(row?.n).toBe(1);
  });
});
