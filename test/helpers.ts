import { env } from 'cloudflare:test';
import type { RequestContext, Session } from '../src/types';

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
