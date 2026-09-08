import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { db, ctxFor, applicantSession } from './helpers';
import { AppError, redact, logError, toErrorResponse, notFound, validationFailed, REDACTED } from '../src/lib/errors';
import type { Env } from '../src/types';

const testEnv = env as unknown as Env;

describe('redaction', () => {
  it('removes secrets by key name at any depth', () => {
    const out = redact({
      resendApiKey: 're_live_abc123',
      nested: { SESSION_TOKEN: 'tok', authorization: 'Bearer x', ok: 'visible' },
      list: [{ signing_key: 'k' }],
    }) as Record<string, any>;

    expect(out.resendApiKey).toBe(REDACTED);
    expect(out.nested.SESSION_TOKEN).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.ok).toBe('visible');
    expect(out.list[0].signing_key).toBe(REDACTED);
  });

  it('never lets a secret survive serialization', () => {
    const json = JSON.stringify(redact({ apiKey: 'SUPERSECRET', a: { b: { c: { token: 'T' } } } }));
    expect(json).not.toContain('SUPERSECRET');
    expect(json).not.toContain('"T"');
  });

  it('scrubs secrets embedded in a message string, not just in keys', () => {
    const out = redact({
      msg: 'failed to verify magic-link token tok_LIVE_abc123def456ghi789 for user',
    }) as Record<string, string>;
    expect(out.msg).not.toContain('tok_LIVE_abc123def456ghi789');
    expect(out.msg).toContain('[redacted-key]');

    const bearer = redact({ m: 'Authorization: Bearer eyJhbGciOi.eyJzdWIi.QSSw5c' }) as Record<string, string>;
    expect(bearer.m).not.toContain('eyJhbGciOi.eyJzdWIi.QSSw5c');

    const url = redact({ m: 'GET /verify?token=SECRETVALUE123&x=1 failed' }) as Record<string, string>;
    expect(url.m).not.toContain('SECRETVALUE123');
  });

  it('does not eat ordinary prose that merely looks long', () => {
    const prose = redact({ m: 'the quick brown fox jumps over the lazy dog' }) as Record<string, string>;
    expect(prose.m).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('redacts a secret nested inside an array of header pairs', () => {
    const out = redact({
      headers: [
        ['authorization', 'Bearer eyJTOPSECRETVALUE'],
        ['cookie', 'sid=abc123'],
        ['accept', 'application/json'],
      ],
    }) as Record<string, string[][]>;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('eyJTOPSECRETVALUE');
    expect(flat).not.toContain('sid=abc123');
    expect(flat).toContain('application/json');
  });

  it('cannot be walked past by a non-enumerable property', () => {
    const o: Record<string, unknown> = { visible: 'ok' };
    Object.defineProperty(o, 'apiKey', { value: 'HIDDENSECRET', enumerable: false });
    expect(JSON.stringify(redact(o))).not.toContain('HIDDENSECRET');
  });

  it('truncates long strings instead of dropping them', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(400);
    const out = redact({ narrative: long }) as Record<string, string>;
    const narrative = out.narrative!;
    expect(narrative.length).toBeLessThan(600);
    expect(narrative).toContain('chars');
  });

  it('caps arrays and depth without throwing', () => {
    const deep: any = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(() => JSON.stringify(redact(deep))).not.toThrow();
    const arr = redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(arr.length).toBeLessThanOrEqual(26);
  });

  it('survives a circular structure', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe('error_log', () => {
  it('writes a row with request correlation and actor', async () => {
    const ctx = ctxFor(applicantSession('org-1', 'user-1'));
    const id = await logError(testEnv, ctx, {
      severity: 'error',
      code: 'INTERNAL',
      message: 'boom',
      context: { applicationId: 'app-1', apiKey: 'nope' },
      httpStatus: 500,
    });
    expect(id).not.toBeNull();

    const row = await db
      .prepare(`SELECT * FROM error_log WHERE id = ?`)
      .bind(id)
      .first<Record<string, any>>();

    expect(row?.request_id).toBe(ctx.requestId);
    expect(row?.actor_user_id).toBe('user-1');
    expect(row?.actor_organization_id).toBe('org-1');
    expect(row?.http_status).toBe(500);
    expect(row?.context_json).toContain('app-1');
    expect(row?.context_json).not.toContain('nope');
  });

  it('never throws, even when the write fails', async () => {
    const brokenEnv = {
      DB: {
        prepare() {
          throw new Error('database is gone');
        },
      },
    } as unknown as Env;
    // A logging failure must not become the user-visible failure.
    await expect(
      logError(brokenEnv, ctxFor(), { severity: 'error', code: 'X', message: 'y' }),
    ).resolves.toBeNull();
  });
});

describe('HTTP error responses', () => {
  it('never leaks an internal message or stack on a 500', async () => {
    const ctx = ctxFor();
    const res = await toErrorResponse(
      new Error('SQLITE_CONSTRAINT: applicant EIN 761234567 already exists'),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('SQLITE');
    expect(body).not.toContain('761234567');
    expect(body).not.toContain('stack');
    expect(JSON.parse(body).error).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong on our end.',
      request_id: ctx.requestId,
    });
    expect(res.headers.get('x-request-id')).toBe(ctx.requestId);
  });

  it('records the full detail in error_log even though the client saw none of it', async () => {
    const ctx = ctxFor();
    await toErrorResponse(new Error('detailed internal failure XYZZY'), testEnv, ctx);
    const row = await db
      .prepare(`SELECT message, stack FROM error_log WHERE request_id = ?`)
      .bind(ctx.requestId)
      .first<{ message: string; stack: string | null }>();
    expect(row?.message).toContain('XYZZY');
    expect(row?.stack).toBeTruthy();
  });

  it('passes plain-language field errors through on a 400', async () => {
    const err = validationFailed([
      { field: 'requested_amount', section: 'Your request', message: 'Enter a dollar amount.' },
    ]);
    const res = await toErrorResponse(err, testEnv, ctxFor());
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.fields).toHaveLength(1);
    expect(body.error.fields[0].field).toBe('requested_amount');
  });

  it('maps notFound to a 404 with a neutral message', async () => {
    const res = await toErrorResponse(notFound('application'), testEnv, ctxFor());
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe('That application could not be found.');
  });

  it('sets no-store so an error is never cached at the edge', async () => {
    const res = await toErrorResponse(new AppError('CONFLICT', 'Already submitted.'), testEnv, ctxFor());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
