/**
 * The client's view of the staff API.
 *
 * Every call is same-origin, so the Cloudflare Access cookie rides along and
 * there is no token for this code to hold, store or leak. A 401 means the
 * Access session lapsed; the only correct response is to reload the page and
 * let Access re-authenticate, which is what the UI offers.
 */

export interface SessionUser {
  email: string;
  role: string;
}

export interface ProgramRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  fiscal_year: number | null;
  compliance_policy: string;
}

export interface CycleRow {
  id: string;
  program_id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  status: string;
  draft_grace_hours: number | null;
  opens_at_display: string;
  closes_at_display: string;
}

export interface FormSummary {
  id: string;
  program_id: string;
  form_key: string;
  stage_id: string | null;
  kind: 'application' | 'report';
  name: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  published_at: string | null;
  program_name: string;
  stage_name: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** Access has expired or was never established. The page must be reloaded. */
  get isSignedOut(): boolean {
    return this.status === 401;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Could not reach Steward. Check your connection.', null);
  }

  const requestId = res.headers.get('x-request-id');

  if (!res.ok) {
    // A failing response is still expected to be JSON. If it is not -- an edge
    // error page, an Access interstitial -- do not try to render its body.
    let code = 'INTERNAL';
    let message = 'Something went wrong. Please try again.';
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      if (res.status === 401 || res.status === 403) {
        code = 'UNAUTHENTICATED';
        message = 'Please sign in to continue.';
      }
    }
    throw new ApiError(res.status, code, message, requestId);
  }

  return (await res.json()) as T;
}

export const api = {
  session: (signal?: AbortSignal) => get<{ user: SessionUser }>('/api/session', signal),
  programs: (signal?: AbortSignal) => get<{ programs: ProgramRow[] }>('/api/programs', signal),
  cycles: (signal?: AbortSignal) => get<{ cycles: CycleRow[] }>('/api/cycles', signal),
  forms: (signal?: AbortSignal) => get<{ forms: FormSummary[] }>('/api/forms', signal),
  form: (id: string, signal?: AbortSignal) =>
    get<{ form: import('../../src/lib/forms').FormDefinition }>(
      `/api/forms/${encodeURIComponent(id)}`,
      signal,
    ),
};
