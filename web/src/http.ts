/**
 * The one place a fetch happens.
 *
 * Extracted so the staff client and the applicant client share exactly one
 * implementation of "what does a failure look like". They differ in what a 401
 * MEANS -- staff reload and let Cloudflare Access re-authenticate, an applicant
 * goes back to the sign-in page -- and that difference belongs to the callers,
 * not to this file.
 *
 * Every call is same-origin, so the session cookie rides along and there is no
 * token for this code to hold, store, or leak.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /**
   * Per-field problems, when the server sent them.
   *
   * `field` is a field_key, so a form can anchor to the input. Present on a
   * validation failure and absent otherwise -- an empty array would suggest a
   * validation failure with nothing wrong.
   */
  readonly fields: { field: string; message: string }[] | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    fields?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fields = fields;
  }

  /** The session has expired or was never established. */
  get isSignedOut(): boolean {
    return this.status === 401;
  }

  /** Nothing reached the server. Worth retrying; not worth alarming anyone. */
  get isOffline(): boolean {
    return this.code === 'NETWORK';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: 'same-origin',
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
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
    let fields: { field: string; message: string }[] | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; fields?: { field: string; message: string }[] };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
      if (Array.isArray(body.error?.fields) && body.error.fields.length > 0) {
        fields = body.error.fields;
      }
    } catch {
      if (res.status === 401 || res.status === 403) {
        code = 'UNAUTHENTICATED';
        message = 'Please sign in to continue.';
      }
    }
    throw new ApiError(res.status, code, message, requestId, fields);
  }

  // The failure path already guarded this; the SUCCESS path did not, so an
  // Access interstitial or an edge error page arriving with a 200 surfaced as
  // `SyntaxError: Unexpected token '<'` in front of the user.
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(
      res.status,
      'BAD_RESPONSE',
      'Steward returned something unexpected. Reload and try again.',
      requestId,
    );
  }
}
