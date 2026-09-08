/**
 * Errors and error logging.
 *
 * Two rules shape this file:
 *
 *   1. A client is told only what it needs. A 5xx returns a stable code and a
 *      request id, never an internal message, never a stack, never a SQL error.
 *      The detail goes to error_log where staff can find it by request id.
 *
 *   2. Nothing sensitive is ever written to a log. Context is redacted before
 *      it is serialized: no tokens, no session ids, no signing keys, no
 *      authorization headers, no raw request bodies full of financial data.
 *
 * Logging must never be the thing that takes a request down. Every write here
 * is best-effort and swallows its own failure to the console.
 */

import type { Env, RequestContext } from '../types';
import { newId } from './ids';
import { nowIso } from './time';

export type Severity = 'warn' | 'error' | 'fatal';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'CYCLE_CLOSED'
  | 'FORM_PUBLISHED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  CYCLE_CLOSED: 409,
  FORM_PUBLISHED: 409,
  INTERNAL: 500,
};

export interface FieldError {
  /** field_key, so the UI can anchor to the input. */
  field: string;
  section?: string;
  /** Plain language. An applicant reads this. */
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly severity: Severity;
  /** Safe to show a client. */
  readonly publicMessage: string;
  readonly context: Record<string, unknown>;
  readonly fieldErrors: FieldError[] | undefined;

  constructor(
    code: ErrorCode,
    publicMessage: string,
    opts: {
      internalMessage?: string;
      severity?: Severity;
      context?: Record<string, unknown>;
      fieldErrors?: FieldError[];
      cause?: unknown;
    } = {},
  ) {
    super(opts.internalMessage ?? publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.publicMessage = publicMessage;
    this.severity = opts.severity ?? (this.httpStatus >= 500 ? 'error' : 'warn');
    this.context = opts.context ?? {};
    this.fieldErrors = opts.fieldErrors;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Not-found is the correct answer for "exists but is not yours".
 *
 * Returning 403 would confirm the row exists, which tells one nonprofit that
 * another nonprofit's application id is real. Changing an id in a URL returns
 * 404 — that is the specified behaviour and this is the helper that produces it.
 */
export function notFound(entity = 'record'): AppError {
  return new AppError('NOT_FOUND', `That ${entity} could not be found.`, {
    internalMessage: `${entity} not found or not in scope`,
    severity: 'warn',
  });
}

export function validationFailed(fieldErrors: FieldError[]): AppError {
  return new AppError('VALIDATION_FAILED', 'Some answers need attention before you can continue.', {
    internalMessage: `validation failed on ${fieldErrors.length} field(s)`,
    severity: 'warn',
    fieldErrors,
  });
}

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

/**
 * Keys whose values are never written to a log, at any depth.
 *
 * Matching is on the key name, case-insensitively, as a substring — so
 * `resendApiKey`, `X-Api-Key` and `session_token` are all caught.
 */
const REDACT_KEY_PATTERN =
  /(secret|token|password|passwd|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|session|signature|signing|credential|private[-_]?key|access[-_]?key)/i;

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 25;
const MAX_CONTEXT_BYTES = 8_000;

export const REDACTED = '[redacted]';

/**
 * Deep-redact and size-cap a context object so it is safe and bounded.
 *
 * Long strings are truncated rather than dropped: a truncated narrative is
 * still useful for debugging, an unbounded one fills the database.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_DEPTH) return '[max depth]';

  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING_LENGTH
      ? `${s.slice(0, MAX_STRING_LENGTH)}…[${s.length} chars]`
      : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

function serializeContext(context: Record<string, unknown>): string | null {
  try {
    let json = JSON.stringify(redact(context));
    if (json === undefined) return null;
    if (json.length > MAX_CONTEXT_BYTES) {
      json = JSON.stringify({
        truncated: true,
        preview: json.slice(0, MAX_CONTEXT_BYTES),
      });
    }
    return json;
  } catch {
    return JSON.stringify({ error: 'context could not be serialized' });
  }
}

// -----------------------------------------------------------------------------
// error_log writes
// -----------------------------------------------------------------------------

export interface LogErrorInput {
  severity: Severity;
  code: string;
  message: string;
  context?: Record<string, unknown>;
  stack?: string | null;
  httpStatus?: number | null;
}

/**
 * Write one row to error_log. Best-effort: a logging failure is reported to the
 * console and swallowed, because failing to log must not fail the request.
 *
 * Returns the id of the row written, or null if the write failed.
 */
export async function logError(
  env: Env,
  ctx: RequestContext | null,
  input: LogErrorInput,
): Promise<string | null> {
  const id = newId();
  try {
    await env.DB.prepare(
      `INSERT INTO error_log (
         id, request_id, severity, code, message, context_json, stack,
         actor_user_id, actor_role, actor_organization_id,
         route, method, http_status, ip, user_agent, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        ctx?.requestId ?? null,
        input.severity,
        input.code,
        // The internal message is itself redacted: a SQL error can echo a bound
        // value, and a bound value can be somebody's financial data.
        String(redact(input.message)),
        serializeContext(input.context ?? {}),
        input.stack ? String(redact(input.stack)) : null,
        ctx?.session?.userId ?? null,
        ctx?.session?.role ?? null,
        ctx?.session?.organizationId ?? null,
        ctx?.route ?? null,
        ctx?.method ?? null,
        input.httpStatus ?? null,
        ctx?.ip ?? null,
        ctx?.userAgent ?? null,
        nowIso(),
      )
      .run();
    return id;
  } catch (writeFailure) {
    console.error('error_log write failed', {
      requestId: ctx?.requestId,
      originalCode: input.code,
      writeFailure: String(writeFailure),
    });
    return null;
  }
}

// -----------------------------------------------------------------------------
// HTTP surface
// -----------------------------------------------------------------------------

/**
 * Turn any thrown value into a client response, and log it.
 *
 * For 5xx the body carries a stable code and the request id and nothing else.
 * The request id is what a grantee reads over the phone to a staff member, who
 * finds the full detail in error_log.
 */
export async function toErrorResponse(
  err: unknown,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const appErr =
    err instanceof AppError
      ? err
      : new AppError('INTERNAL', 'Something went wrong on our end.', {
          internalMessage: err instanceof Error ? err.message : String(err),
          severity: 'error',
          cause: err,
        });

  await logError(env, ctx, {
    severity: appErr.severity,
    code: appErr.code,
    message: appErr.message,
    context: appErr.context,
    stack: err instanceof Error ? (err.stack ?? null) : null,
    httpStatus: appErr.httpStatus,
  });

  const body: Record<string, unknown> = {
    error: {
      code: appErr.code,
      // Never appErr.message here: that is the internal one.
      message: appErr.publicMessage,
      request_id: ctx.requestId,
    },
  };
  if (appErr.fieldErrors?.length) {
    (body.error as Record<string, unknown>).fields = appErr.fieldErrors;
  }

  return new Response(JSON.stringify(body), {
    status: appErr.httpStatus,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': ctx.requestId,
      'cache-control': 'no-store',
    },
  });
}
