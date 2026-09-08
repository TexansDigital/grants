/**
 * Shared types for the Steward Worker.
 */

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SESSIONS: KVNamespace;
  ENVIRONMENT: string;
  DISPLAY_TIMEZONE: string;
}

export type Role = 'admin' | 'reviewer' | 'applicant' | 'grantee' | 'executive';

/**
 * The authenticated session.
 *
 * `organizationId` is the ONLY source of organization scoping in the system.
 * It is derived from the session at authentication time and is never read from
 * a request parameter, body, or header. See lib/scope.ts.
 */
export interface Session {
  userId: string;
  email: string;
  role: Role;
  /** Always set for applicant/grantee, always null for admin/reviewer/executive. */
  organizationId: string | null;
}

/** Request-scoped context threaded through handlers for audit and error logging. */
export interface RequestContext {
  requestId: string;
  session: Session | null;
  ip: string | null;
  userAgent: string | null;
  route: string | null;
  method: string | null;
}
