import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { db, ctxFor, adminSession } from './helpers';
import { seedProgram } from '../src/seed/seedProgram';
import { INSPIRE_CHANGE } from '../src/seed/inspireChange';
import { createSession, SESSION_COOKIE } from '../src/lib/sessions';
import { presignUpload, objectKey, PRESIGN_TTL_SECONDS } from '../src/lib/uploads';
import { newId } from '../src/lib/ids';
import { nowIso } from '../src/lib/time';
import type { Env, Session } from '../src/types';
import type { AppError } from '../src/lib/errors';

const ORIGIN = 'https://applications.example.org';
/** Invented credentials; nothing here reaches Cloudflare. */
const r2Env = (over: Partial<Env> = {}): Env => ({
  ...(testEnv as unknown as Env),
  APPLICANT_BASE_URL: ORIGIN,
  R2_ACCESS_KEY_ID: 'demo-access-key-id',
  R2_SECRET_ACCESS_KEY: 'demo-secret-access-key',
  R2_BUCKET_NAME: 'steward-preview-files',
  R2_ACCOUNT_ID: 'abc123account',
  ...over,
});

let n = 0;

async function applicantWithDraft() {
  const p = await seedProgram(db, ctxFor(adminSession()), { ...INSPIRE_CHANGE, slug: `up-${++n}` });
  const cycleId = Object.values(p.cycleIds)[0]!;
  const orgId = newId();
  const userId = newId();
  const now = nowIso();
  await db.prepare(
    `INSERT INTO organizations (id, legal_name, ein, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)`,
  ).bind(orgId, 'Invented Futures', String(500000000 + n), now, now).run();
  await db.prepare(
    `INSERT INTO users (id, email, role, organization_id, is_active, created_at, updated_at)
     VALUES (?,?, 'applicant', ?, 1, ?, ?)`,
  ).bind(userId, `u${n}-${crypto.randomUUID().slice(0, 6)}@example.org`, orgId, now, now).run();

  const applicationId = newId();
  await db.prepare(
    `INSERT INTO applications (id, cycle_id, stage_id, organization_id, form_definition_id,
       status, created_at, updated_at)
     SELECT ?, ?, fd.stage_id, ?, fd.id, 'draft', ?, ?
       FROM form_definitions fd WHERE fd.id = ?`,
  ).bind(applicationId, cycleId, orgId, now, now, p.formDefinitionIds.application!).run();

  const session: Session = { userId, email: 'x@example.org', role: 'applicant', organizationId: orgId };
  const { sessionToken } = await createSession(r2Env(), userId);
  return { applicationId, orgId, userId, session, cookie: `${SESSION_COOKIE}=${sessionToken}` };
}

const goodIntent = {
  fieldKey: 'financial_statements',
  filename: 'audited-2025.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1_200_000,
};

beforeEach(async () => {
  for (const k of (await testEnv.SESSIONS.list({ prefix: 'rl:' })).keys) {
    await testEnv.SESSIONS.delete(k.name);
  }
});

// ---------------------------------------------------------------------------
describe('the presigned URL, which is a bearer token', () => {
  it('signs a PUT in the query string, for the right bucket and key', async () => {
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent);

    const url = new URL(out.uploadUrl);
    expect(url.host).toBe('steward-preview-files.abc123account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/${objectKey(a.orgId, out.attachmentId)}`);
    // signQuery: the signature is in the URL, which is what makes a plain
    // browser PUT work at all.
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_TTL_SECONDS));
  });

  it('does NOT sign content-type, and asks the browser to send no headers', async () => {
    // CLAUDE.md, learned the hard way: signing extra headers produces a 403
    // that does not reproduce in curl. R2 records the correct type anyway.
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent);
    const signed = new URL(out.uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed).toBe('host');
    expect(signed).not.toContain('content-type');
    expect(out.headers).toEqual({});
  });

  it('is short-lived', async () => {
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent);
    const ttl = Date.parse(out.expiresAt) - Date.now();
    expect(ttl).toBeLessThanOrEqual(PRESIGN_TTL_SECONDS * 1000 + 2000);
    expect(PRESIGN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });

  it('keeps the applicant filename out of the object key', async () => {
    // Filenames carry beneficiary names and organization names, and object
    // keys turn up in logs.
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, {
      ...goodIntent, filename: 'Smith Family Trust financials.pdf',
    });
    expect(out.uploadUrl).not.toContain('Smith');
    expect(objectKey(a.orgId, out.attachmentId)).toBe(`org/${a.orgId}/${out.attachmentId}`);
  });

  it('records the attachment against the organization, unclaimed', async () => {
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent);
    const row = await db.prepare(`SELECT * FROM attachments WHERE id = ?`)
      .bind(out.attachmentId).first<Record<string, unknown>>();
    expect(row!.organization_id).toBe(a.orgId);
    // Null until submit claims it: a file exists before there is an
    // application to attach it to.
    expect(row!.parent_id).toBeNull();
    expect(row!.filename).toBe('audited-2025.pdf');
    expect(row!.uploaded_by).toBe(a.userId);
  });

  it('audits the upload', async () => {
    const a = await applicantWithDraft();
    const out = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent);
    const row = await db
      .prepare(`SELECT after_json FROM audit_log WHERE action='attachment.uploaded' AND entity_id=?`)
      .bind(out.attachmentId).first<{ after_json: string }>();
    expect(row).not.toBeNull();
    // The object path is on the attachment row; it is not repeated into an
    // audit snapshot that more people read than need it.
    expect(row!.after_json).not.toContain('org/');
  });
});

// ---------------------------------------------------------------------------
describe('what it refuses', () => {
  /**
   * Returns the AppError, so a test can assert on BOTH messages.
   *
   * `Error.message` is the internal one, written for a log. `publicMessage` is
   * what the applicant sees. Asserting only the former would let the applicant
   * be shown an internal string without any test noticing.
   */
  const reject = async (intent: Partial<typeof goodIntent>): Promise<AppError> => {
    const a = await applicantWithDraft();
    try {
      await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, {
        ...goodIntent, ...intent,
      });
    } catch (err) {
      return err as AppError;
    }
    throw new Error('expected a rejection');
  };

  it('a file type the field does not allow', async () => {
    const e = await reject({ mimeType: 'application/x-msdownload' });
    expect(e.publicMessage).toMatch(/PDF, Word/);
    expect(e.code).toBe('VALIDATION_FAILED');
  });

  it('a file over the field limit', async () => {
    // The application form sets 8 MB on this field.
    expect((await reject({ sizeBytes: 9_000_000 })).publicMessage).toMatch(/smaller than 8 MB/);
  });

  it('a zero-byte or nonsense size', async () => {
    expect((await reject({ sizeBytes: 0 })).publicMessage).toMatch(/could not be read/);
    expect((await reject({ sizeBytes: -5 })).publicMessage).toMatch(/could not be read/);
  });

  it('a filename with a path separator in it', async () => {
    expect((await reject({ filename: '../../etc/passwd' })).publicMessage)
      .toMatch(/unsupported file name/);
  });

  it('a field that is not a file upload, and one that does not exist', async () => {
    for (const fieldKey of ['project_title', 'no_such_field']) {
      const e = await reject({ fieldKey });
      expect(e.publicMessage).toMatch(/not a field you can upload/);
      // The internal message names the field; the applicant's does not need to.
      expect(e.message).toContain(fieldKey);
    }
  });

  it('creates no attachment row when it refuses', async () => {
    const a = await applicantWithDraft();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM attachments`).first<{ n: number }>();
    await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, {
      ...goodIntent, mimeType: 'application/x-msdownload',
    }).catch(() => undefined);
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM attachments`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('refuses rather than half-works when R2 is not configured', async () => {
    const a = await applicantWithDraft();
    for (const missing of [{ R2_SECRET_ACCESS_KEY: '' }, { R2_ACCOUNT_ID: '' }, { R2_BUCKET_NAME: '' }]) {
      const err = await presignUpload(
        r2Env(missing), ctxFor(a.session), a.session, a.applicationId, goodIntent,
      ).then(() => null, (e: AppError) => e);
      expect(err, JSON.stringify(missing)).not.toBeNull();
      // The applicant is told nothing about our storage configuration.
      expect(err!.publicMessage).toMatch(/not available right now/);
      expect(err!.code).toBe('INTERNAL');
      expect(err!.message).toMatch(/R2/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('scoping and lifecycle', () => {
  it('404s an upload into another organization’s application', async () => {
    const mine = await applicantWithDraft();
    const theirs = await applicantWithDraft();
    const err = await presignUpload(
      r2Env(), ctxFor(mine.session), mine.session, theirs.applicationId, goodIntent,
    ).then(() => null, (e: AppError) => e);
    // 404, not 403: a 403 would confirm the other application is real.
    expect(err!.code).toBe('NOT_FOUND');
  });

  it('refuses an upload to an application already submitted', async () => {
    const a = await applicantWithDraft();
    await db.prepare(`UPDATE applications SET status='submitted', submitted_at=? WHERE id=?`)
      .bind(nowIso(), a.applicationId).run();
    const err = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent)
      .then(() => null, (e: AppError) => e);
    expect(err!.code).toBe('CONFLICT');
    expect(err!.publicMessage).toMatch(/already been submitted/);
  });

  it('is reachable over HTTP with a session, and not without one', async () => {
    const a = await applicantWithDraft();
    const call = (cookie?: string) =>
      worker.fetch(
        new Request(`${ORIGIN}/api/applications/${a.applicationId}/uploads`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.10',
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(goodIntent),
        }),
        r2Env(),
        {} as ExecutionContext,
      );

    expect((await call()).status).toBe(401);
    const ok = await call(a.cookie);
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { uploadUrl: string; headers: Record<string, string> };
    expect(body.uploadUrl).toContain('X-Amz-Signature');
    expect(body.headers).toEqual({});
  });

  it('404s an upload into a soft-deleted application', async () => {
    // Nothing is hard-deleted, so "deleted" is a column that every read has to
    // honour. A scoped read that forgets it keeps serving presigned URLs for
    // an application an admin has removed.
    const a = await applicantWithDraft();
    await db.prepare(`UPDATE applications SET deleted_at = ? WHERE id = ?`)
      .bind(nowIso(), a.applicationId).run();
    const err = await presignUpload(r2Env(), ctxFor(a.session), a.session, a.applicationId, goodIntent)
      .then(() => null, (e: AppError) => e);
    expect(err!.code).toBe('NOT_FOUND');
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE organization_id = ?`)
      .bind(a.orgId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('refuses a session carrying no organization', async () => {
    // Not reachable through the router today, because the applicant role is
    // always resolved with an organization. It is asserted anyway: the guard
    // is what stands between a future staff-shaped session and an unscoped
    // object key, and an unreachable guard with no test is a guard that gets
    // deleted as dead code.
    const a = await applicantWithDraft();
    const orphan = { ...a.session, organizationId: undefined } as unknown as Session;
    const err = await presignUpload(r2Env(), ctxFor(a.session), orphan, a.applicationId, goodIntent)
      .then(() => null, (e: AppError) => e);
    expect(err!.code).toBe('FORBIDDEN');
    expect(err!.publicMessage).toMatch(/not linked to an organization/);
    expect(err!.message).toMatch(/no organization on the session/);
  });
});
