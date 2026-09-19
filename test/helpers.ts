import { env } from 'cloudflare:test';
import type { RequestContext, Session } from '../src/types';
import { AppError } from '../src/lib/errors';

export const db = env.DB as unknown as D1Database;

export function ctxFor(session: Session | null = null): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    session,
    ip: '203.0.113.10',
    userAgent: 'vitest',
    route: '/test',
    method: 'POST',
  };
}

export function applicantSession(organizationId: string, userId = crypto.randomUUID()): Session {
  return { userId, email: 'applicant@example.org', role: 'applicant', organizationId };
}

export function adminSession(userId = crypto.randomUUID()): Session {
  return { userId, email: 'admin@example.org', role: 'admin', organizationId: null };
}

export function reviewerSession(userId = crypto.randomUUID()): Session {
  return { userId, email: 'reviewer@example.org', role: 'reviewer', organizationId: null };
}

/**
 * The AppError a call threw, for asserting on its CLIENT-facing message.
 *
 * Exists because the two obvious ways of doing this are both wrong here:
 *
 *   `rejects.toThrow(/.../)` matches Error.message, which on an AppError is
 *   the INTERNAL message. A test written that way passes while saying nothing
 *   about what the person on the other end was actually told.
 *
 *   `rejects.toMatchObject({ publicMessage: /.../ })` matches NOTHING. Vitest
 *   treats a bare RegExp inside toMatchObject as satisfied by any string, so
 *   the assertion is silently vacuous. Two tests here were written that way and
 *   passed against completely different errors; only a mutant found it. See the
 *   canary in regressions.test.ts.
 */
export async function appErrorFrom(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected this call to fail, and it succeeded');
}
