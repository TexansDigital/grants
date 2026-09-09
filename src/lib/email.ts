/**
 * Outbound email: the send path.
 *
 * Three responsibilities, deliberately separated:
 *
 *   emailTemplates.ts  copy and rendering. Pure. No I/O, no provider.
 *   this file          the decision to send, the record of it, idempotency.
 *   EmailTransport     the provider call. One implementation (Resend), fully
 *                      injectable, so nothing in the test suite can reach the
 *                      network and accidentally mail a real person.
 *
 * WHY A RECORD FIRST, THEN A SEND: the row is written as 'queued' BEFORE the
 * provider is called. If the Worker dies mid-call, the evidence that a send was
 * attempted survives. The reverse order loses exactly the cases you most need
 * to investigate.
 */

import type { Env, RequestContext } from '../types';
import type { EmailTemplate, RenderedEmail } from './emailTemplates';
import { newId } from './ids';
import { nowIso } from './time';
import { logError, redact, scrubSecrets } from './errors';

export type EmailStatus = 'queued' | 'sent' | 'failed' | 'suppressed';

export interface SendOutcome {
  messageId: string;
  status: EmailStatus;
  /**
   * An earlier message with this key already existed AND nothing was sent.
   * False for a re-drive, which reuses the row but does perform a send.
   */
  deduplicated: boolean;
  /** This call rescued a stranded 'queued' row rather than creating one. */
  redriven?: boolean;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

export interface OutboundEmail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Passed to the provider so a retried HTTP call cannot double-deliver. */
  idempotencyKey: string;
}

export type TransportResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; code: string; message: string };

export interface EmailTransport {
  send(msg: OutboundEmail): Promise<TransportResult>;
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * The Resend transport.
 *
 * `fetcher` is injected rather than closed over so tests exercise this function
 * -- the header assembly, the status handling, the timeout -- without a
 * network. A transport that is only ever replaced wholesale in tests is a
 * transport whose own logic is never tested.
 */
export function resendTransport(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): EmailTransport {
  return {
    async send(msg) {
      // A hung provider must not hold a Worker request open indefinitely.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await fetcher(RESEND_ENDPOINT, {
          method: 'POST',
          signal: abort.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            // Resend's own dedupe. Belt and braces with the UNIQUE index: this
            // one covers a retry of the HTTP call itself, the index covers a
            // second run of the handler.
            'idempotency-key': msg.idempotencyKey,
          },
          body: JSON.stringify({
            from: msg.from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
            ...(msg.replyTo ? { reply_to: [msg.replyTo] } : {}),
          }),
        });

        if (!res.ok) {
          // Read the body for diagnosis, but never assume it is JSON: a 502
          // from an edge in front of the API is HTML, and a parse failure here
          // would turn a useful error into an unhelpful one.
          const body = await res.text().catch(() => '');
          return {
            ok: false,
            code: `PROVIDER_${res.status}`,
            message: body.slice(0, PROVIDER_MESSAGE_LIMIT) || res.statusText || 'no response body',
          };
        }

        const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { ok: true, providerMessageId: typeof json?.id === 'string' ? json.id : null };
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        return {
          ok: false,
          code: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The transport for an environment, or null when email is not configured.
 *
 * Null is the normal state in preview and in tests, and it is why a development
 * run cannot mail a real applicant even if a handler asks it to.
 */
export function transportFor(env: Env, fetcher: typeof fetch = fetch): EmailTransport | null {
  const key = (env.RESEND_API_KEY ?? '').trim();
  return key ? resendTransport(key, fetcher) : null;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. This is a sanity check against an empty string or a
 * value that is plainly not an address, not an attempt to decide which real
 * addresses exist -- that judgement belongs to the provider, and every
 * home-grown stricter pattern eventually rejects somebody's real mailbox.
 */
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Was this failure the idempotency key already being held?
 *
 * Matched on the message migration 0008 raises, which this codebase owns, so
 * it does not depend on how D1 words a generic constraint failure. Any other
 * error is re-thrown.
 */
function isKeyClaimed(err: unknown): boolean {
  return err instanceof Error && err.message.includes('idempotency_key is already claimed');
}

const MAX_SUBJECT = 300;
/** Shared by the transport and the stored row, so neither silently truncates first. */
export const PROVIDER_MESSAGE_LIMIT = 500;

/**
 * How long a message may sit 'queued' before another call may re-drive it.
 *
 * A row is only left 'queued' when the process died between claiming the key
 * and settling the outcome. Without a re-drive that row owns its idempotency
 * key forever, and every later call dedupes against it and sends nothing --
 * so a single crash permanently suppresses that message. For a one-per-entity
 * message like a submission confirmation, the applicant simply never receives
 * it and no amount of retrying helps.
 *
 * Ten minutes is chosen against two bounds, not picked for feel:
 *
 *   LOWER  the provider call times out after PROVIDER_TIMEOUT_MS (10s), so a
 *          row queued for ten minutes cannot still be in flight. There is no
 *          race with a live request.
 *   UPPER  the same idempotency key is sent to Resend, whose keys de-duplicate
 *          for 24 hours. Re-driving well inside that window means that if the
 *          provider DID accept the first call before we crashed, it suppresses
 *          the second rather than delivering twice. The provider is what makes
 *          self-healing safe here; the window is what keeps us inside it.
 */
export const REDRIVE_AFTER_MS = 10 * 60 * 1000;

export interface SendEmailOptions<V> {
  template: EmailTemplate<V>;
  vars: V;
  to: string;
  /**
   * The dedupe boundary. MUST be derived from what makes this message unique
   * (e.g. `application_received:${applicationId}`), never randomly generated --
   * a random key makes every call a new message and defeats the guarantee.
   */
  idempotencyKey: string;
  /**
   * Who approved this send. Required for templates marked
   * requiresHumanRelease; ignored otherwise.
   */
  releasedByUserId?: string;
  /** Redacted before storage. Entity ids only -- never tokens, never answers. */
  context?: Record<string, unknown>;
  /** Links this attempt to the one it replaces. */
  retryOfMessageId?: string;
}

/**
 * Send one email, once.
 *
 * Returns rather than throws for a provider failure: a failed confirmation
 * email must not roll back a successfully submitted application. The caller
 * inspects `status`. Programmer errors -- an unreleased decline, a malformed
 * address -- do throw, because those are bugs rather than conditions.
 */
export async function sendEmail<V>(
  env: Env,
  ctx: RequestContext,
  opts: SendEmailOptions<V>,
  // REQUIRED, with no default. A default of transportFor(env) was a production
  // code path that no test could execute -- every test passes a transport, so
  // changing the default to null left the entire suite green while production
  // would have recorded every message as suppressed and mailed nobody. A
  // caller writes transportFor(env) explicitly; that function is tested on its
  // own, and there is no longer an untestable path between them.
  transport: EmailTransport | null,
): Promise<SendOutcome> {
  const db = env.DB;
  const to = opts.to.trim();

  if (!ADDRESS.test(to)) {
    throw new Error(`sendEmail: refusing an address that is not deliverable`);
  }
  if (!opts.idempotencyKey.trim()) {
    throw new Error('sendEmail: an idempotency key is required');
  }
  // Non-negotiable: decline emails are never sent automatically. Enforced on
  // the send path so it holds for every caller, including ones not yet written.
  // Trimmed, not merely truthy: '   ' is truthy, and a whitespace string
  // recorded in released_by_user_id is an audit row that resolves to nobody.
  const releasedBy = opts.releasedByUserId?.trim() || null;
  if (opts.template.requiresHumanRelease && !releasedBy) {
    throw new Error(
      `sendEmail: template '${opts.template.key}' requires a human release and none was given`,
    );
  }

  const from = (env.EMAIL_FROM ?? '').trim();
  if (!from) throw new Error('sendEmail: EMAIL_FROM is not configured');

  const rendered = opts.template.render(opts.vars);
  const subject = rendered.subject.slice(0, MAX_SUBJECT);

  const id = newId();
  const now = nowIso();
  const contextJson = opts.context ? JSON.stringify(redact(opts.context)) : null;

  // Claim the idempotency key with a single atomic INSERT. Not a
  // check-then-insert: that has a window in which two concurrent requests both
  // see nothing and both send.
  //
  // No ON CONFLICT clause, because migration 0008's key_claimed trigger is a
  // BEFORE INSERT trigger and therefore fires BEFORE SQLite would resolve a
  // conflict -- an ON CONFLICT here would never be reached. The trigger is the
  // gate, and losing the claim surfaces as its abort, caught below.
  let claimedByUs = true;
  const claim = db
    .prepare(
      `INSERT INTO email_messages
         (id, idempotency_key, template_key, to_email, subject, status, provider,
          released_by_user_id, context_json, request_id, retry_of_message_id,
          created_at, updated_at)
       VALUES (?,?,?,?,?,'queued','resend',?,?,?,?,?,?)`,
    )
    .bind(
      id,
      opts.idempotencyKey,
      opts.template.key,
      to,
      subject,
      releasedBy,
      contextJson,
      ctx.requestId,
      opts.retryOfMessageId ?? null,
      now,
      now,
    );

  try {
    await claim.run();
  } catch (err) {
    // Only the key-claimed abort means "somebody else owns this message".
    // Anything else -- a CHECK violation, a replace attempt, a real database
    // fault -- is a bug and must not be swallowed into a cheerful dedupe.
    if (!isKeyClaimed(err)) throw err;
    claimedByUs = false;
  }

  if (!claimedByUs) {
    // Someone already owns this key.
    const existing = await db
      .prepare(
        `SELECT id, status, provider_message_id, error_code, to_email, template_key,
                created_at, updated_at
           FROM email_messages WHERE idempotency_key = ?`,
      )
      .bind(opts.idempotencyKey)
      .first<{
        id: string;
        status: EmailStatus;
        provider_message_id: string | null;
        error_code: string | null;
        to_email: string;
        template_key: string;
        created_at: string;
        updated_at: string;
      }>();

    if (!existing) {
      // The key was taken and is now gone. Nothing can delete a row here, so
      // this means the schema guarantees have been broken rather than that a
      // race was lost. Refuse rather than invent an outcome.
      throw new Error('sendEmail: idempotency key is held by a row that cannot be read');
    }

    // The key must identify ONE message. Reusing it for a different recipient
    // or a different template is a caller bug, and the dangerous kind: without
    // this check the second person's copy is silently dropped and the caller is
    // told 'sent'. That is the precise failure email_messages exists to make
    // impossible -- the system says we emailed them, the row says we emailed
    // them, and nobody did. Keys must be derived from the recipient and
    // template as well as the entity.
    if (existing.to_email !== to || existing.template_key !== opts.template.key) {
      throw new Error(
        `sendEmail: idempotency key already belongs to a different message ` +
          `(template '${existing.template_key}', a different recipient or template ` +
          `than this call). Derive the key from recipient and template too.`,
      );
    }

    // Self-healing. A row still 'queued' long after any request could be in
    // flight is a message stranded by a crash, not one in progress.
    if (existing.status === 'queued' && isRedrivable(existing.created_at)) {
      // Claim the re-drive optimistically against updated_at, so two callers
      // arriving together cannot both deliver. The loser reports the row
      // untouched rather than sending a second copy.
      const claimedRedrive = await db
        .prepare(
          `UPDATE email_messages SET updated_at = ?
            WHERE id = ? AND status = 'queued' AND updated_at = ?`,
        )
        .bind(nowIso(), existing.id, existing.updated_at)
        .run();

      if (claimedRedrive.meta.changes >= 1) {
        const outcome = await deliver(env, ctx, existing.id, {
          to,
          from,
          subject,
          rendered,
          idempotencyKey: opts.idempotencyKey,
          templateKey: opts.template.key,
          transport,
        });
        return { ...outcome, redriven: true };
      }
    }

    return {
      messageId: existing.id,
      status: existing.status,
      deduplicated: true,
      providerMessageId: existing.provider_message_id,
      errorCode: existing.error_code,
    };
  }

  return deliver(env, ctx, id, {
    to,
    from,
    subject,
    rendered,
    idempotencyKey: opts.idempotencyKey,
    templateKey: opts.template.key,
    transport,
  });
}

/**
 * Age a row must reach before another call may take it over.
 *
 * An unparseable timestamp is treated as NOT redrivable: a corrupt row is not
 * a licence to send. That is the safe direction -- a message that never goes
 * out is visible in the table as a stuck 'queued' row, whereas a duplicate
 * decision letter is visible in somebody's inbox.
 */
export function isRedrivable(createdAt: string, now: Date = new Date()): boolean {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return now.getTime() - created >= REDRIVE_AFTER_MS;
}

/**
 * Call the provider for an already-claimed row and record what happened.
 *
 * Shared by the first attempt and by a re-drive, so a stranded row settles by
 * exactly the same code path that a fresh one does. Two implementations of
 * "what counts as sent" would drift.
 */
async function deliver(
  env: Env,
  ctx: RequestContext,
  messageId: string,
  msg: {
    to: string;
    from: string;
    subject: string;
    rendered: RenderedEmail;
    idempotencyKey: string;
    templateKey: string;
    transport: EmailTransport | null;
  },
): Promise<SendOutcome> {
  const db = env.DB;
  const { transport } = msg;

  if (!transport) {
    // No provider configured. This is the expected state in preview and in
    // tests, and it is recorded rather than silently skipped so that "why did
    // nobody get an email" has an answer in the database.
    await settle(db, messageId, { status: 'suppressed', errorCode: null, errorMessage: null });
    return { messageId, status: 'suppressed', deduplicated: false };
  }

  const result = await transport.send({
    to: msg.to,
    from: msg.from,
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim() || undefined,
    subject: msg.subject,
    text: msg.rendered.text,
    html: msg.rendered.html,
    idempotencyKey: msg.idempotencyKey,
  });

  if (result.ok) {
    await settle(db, messageId, {
      status: 'sent',
      providerMessageId: result.providerMessageId,
      errorCode: null,
      errorMessage: null,
    });
    return {
      messageId,
      status: 'sent',
      deduplicated: false,
      providerMessageId: result.providerMessageId,
    };
  }

  await settle(db, messageId, {
    status: 'failed',
    errorCode: result.code,
    // Scrubbed for the same reason logError scrubs: email_messages is
    // append-only with no delete path, and this string is up to 500 bytes of
    // whatever the provider chose to return -- which for a validation error can
    // quote the request back, and the request contained a magic link.
    errorMessage: scrubSecrets(result.message).slice(0, PROVIDER_MESSAGE_LIMIT),
  });
  // Also to the error log, which is where operational failures are watched.
  // The template key and recipient go in; the body never does.
  await logError(env, ctx, {
    severity: 'error',
    code: 'EMAIL_SEND_FAILED',
    message: `${msg.templateKey} to ${msg.to}: ${result.code}`,
    context: { email_message_id: messageId, template: msg.templateKey, provider_code: result.code },
  });

  return { messageId, status: 'failed', deduplicated: false, errorCode: result.code };
}

async function settle(
  db: D1Database,
  id: string,
  fields: {
    status: Exclude<EmailStatus, 'queued'>;
    providerMessageId?: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE email_messages
          SET status = ?, provider_message_id = ?, error_code = ?, error_message = ?,
              sent_at = CASE WHEN ? = 'sent' THEN ? ELSE NULL END, updated_at = ?
        WHERE id = ? AND status = 'queued'`,
    )
    .bind(
      fields.status,
      fields.providerMessageId ?? null,
      fields.errorCode,
      fields.errorMessage,
      fields.status,
      now,
      now,
      id,
    )
    .run();
}
