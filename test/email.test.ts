import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, ctxFor, adminSession } from './helpers';
import {
  sendEmail,
  resendTransport,
  transportFor,
  type EmailTransport,
  type OutboundEmail,
  type TransportResult,
  PROVIDER_TIMEOUT_MS,
  REDRIVE_AFTER_MS,
  isRedrivable,
} from '../src/lib/email';
import {
  SIGN_IN_LINK,
  APPLICATION_RECEIVED,
  TEMPLATES,
  escapeHtml,
  type EmailTemplate,
} from '../src/lib/emailTemplates';
import type { Env } from '../src/types';

const ctx = () => ctxFor(adminSession());

/** An env with email configured, without touching the real bindings. */
function mailEnv(over: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), EMAIL_FROM: 'Foundation <grants@example.org>', ...over };
}

/** Records what it was asked to send. Nothing in this suite reaches a network. */
function recorder(result: TransportResult = { ok: true, providerMessageId: 'prov-1' }) {
  const sent: OutboundEmail[] = [];
  const transport: EmailTransport = {
    async send(msg) {
      sent.push(msg);
      return result;
    },
  };
  return { sent, transport };
}

/**
 * A long, distinctive token. A three-character one collides with a random UUID
 * in the row often enough to fail spuriously (~1 run in 56), and a spurious
 * failure here reads as a credential leak.
 */
const TOKEN = 'TOKENDONOTSTORE8f2c41d9b7e6a350cc19';

const RECEIVED_VARS = {
  organizationName: 'Bayou Reach Collective & Friends',
  programName: 'Inspire Change',
  projectTitle: 'Literacy Lab',
  requestedAmount: '$25,000.00',
  submittedAtDisplay: 'March 1, 2026 at 4:12 PM CST',
  confirmationCode: 'IC-2026-0042',
  answers: [
    { section: 'Organization', label: 'Mission statement', value: 'Literacy for <all>' },
    { section: 'Organization', label: 'Website', value: '' },
    { section: 'Your request', label: 'Counties served', value: 'Harris County\nFort Bend County' },
  ],
};

const SIGN_IN_VARS = {
  url: `https://grants.example.org/signin?t=${TOKEN}`,
  expiresInMinutes: 15,
  destination: 'Inspire Change application',
  requestedAtDisplay: 'March 1, 2026 at 9:12 PM CST',
  requestAnotherUrl: 'https://applications.example.org/sign-in',
};

async function row(id: string) {
  return db
    .prepare(`SELECT * FROM email_messages WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

let n = 0;
const key = () => `test-key-${++n}-${crypto.randomUUID()}`;

// ---------------------------------------------------------------------------
describe('sending', () => {
  it('renders, sends, and records one row', async () => {
    const { sent, transport } = recorder();
    const k = key();
    const out = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'Person@Example.org ', idempotencyKey: k },
      transport,
    );

    expect(out.status).toBe('sent');
    expect(out.deduplicated).toBe(false);
    expect(out.providerMessageId).toBe('prov-1');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('Person@Example.org'); // trimmed, case preserved
    expect(sent[0]!.from).toBe('Foundation <grants@example.org>');
    expect(sent[0]!.idempotencyKey).toBe(k);
    expect(sent[0]!.text).toContain(SIGN_IN_VARS.url);
    expect(sent[0]!.html).toContain(SIGN_IN_VARS.url);

    expect(sent[0]!.subject).toBe('Sign in to your Inspire Change application');

    const r = await row(out.messageId);
    expect(r!.status).toBe('sent');
    expect(r!.template_key).toBe('sign_in_link');
    // The subject is the one part of the body the table keeps, precisely so a
    // human can answer "what did we send them".
    expect(r!.subject).toBe('Sign in to your Inspire Change application');
    expect(r!.to_email).toBe('Person@Example.org');
    expect(r!.provider).toBe('resend');
    expect(r!.provider_message_id).toBe('prov-1');
    expect(r!.sent_at).toBeTruthy();
    expect(r!.request_id).toBeTruthy();
  });

  it('never stores the rendered body, because it contains a live credential', async () => {
    const { transport } = recorder();
    const out = await sendEmail(
      mailEnv(),
      ctx(),
      {
        template: SIGN_IN_LINK,
        vars: SIGN_IN_VARS,
        to: 'a@example.org',
        idempotencyKey: key(),
        context: { application_id: 'app-1' },
      },
      transport,
    );

    // Scan the WHOLE row, not a named column: a body stored in a column added
    // later would slip past an assertion that only checks the ones we know.
    const r = await row(out.messageId);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('signin?t=');
    expect(serialized).not.toContain(TOKEN);
    expect(r!.context_json).toBe('{"application_id":"app-1"}');
  });

  it('records a provider failure with its reason and does not throw', async () => {
    const { transport } = recorder({ ok: false, code: 'PROVIDER_422', message: 'bad domain' });
    const out = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      transport,
    );

    expect(out.status).toBe('failed');
    expect(out.errorCode).toBe('PROVIDER_422');
    const r = await row(out.messageId);
    expect(r!.error_code).toBe('PROVIDER_422');
    expect(r!.error_message).toBe('bad domain');
    expect(r!.sent_at).toBeNull();

    // It also reaches the error log, which is where failures are watched.
    const logged = await db
      .prepare(`SELECT code, message FROM error_log WHERE code = 'EMAIL_SEND_FAILED'`)
      .first<{ code: string; message: string }>();
    expect(logged?.message).toContain('sign_in_link');
  });

  it('scrubs a provider error before storing it in an undeletable row', async () => {
    // The provider chooses this string. A validation error that quotes the
    // request back would otherwise put a live magic link into a table with a
    // no-delete trigger and no delete path.
    const leak = `{"error":"invalid","html":"https://grants.example.org/signin?t=${TOKEN}"}`;
    const { transport } = recorder({ ok: false, code: 'PROVIDER_422', message: leak });
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      transport,
    );
    const stored = String((await row(out.messageId))!.error_message);
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain('[redacted]');
  });

  it('never puts the rendered body into the error log either', async () => {
    // email_messages is tested for this above; error_log is the other
    // append-only table on this path and was covered by a comment alone.
    const { transport } = recorder({ ok: false, code: 'PROVIDER_500', message: 'boom' });
    await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      transport,
    );
    const rows = await db
      .prepare(`SELECT message, context_json FROM error_log WHERE code='EMAIL_SEND_FAILED'`)
      .all<{ message: string; context_json: string | null }>();
    for (const r of rows.results) {
      expect(`${r.message} ${r.context_json ?? ''}`).not.toContain(TOKEN);
    }
  });

  it('suppresses rather than sends when no provider is configured', async () => {
    const out = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      null,
    );
    expect(out.status).toBe('suppressed');
    const r = await row(out.messageId);
    expect(r!.status).toBe('suppressed');
    expect(r!.sent_at).toBeNull();
  });

  it('records the attempt before calling the provider, so a crash leaves evidence', async () => {
    // The row is written as 'queued' BEFORE the provider is called. If the
    // Worker dies mid-call, the evidence that a send was attempted survives.
    // A transport that throws rather than returning a failure is the closest
    // this suite can get to that crash.
    const exploding: EmailTransport = {
      async send() {
        throw new Error('worker died mid-call');
      },
    };
    const k = key();
    await expect(
      sendEmail(
        mailEnv(),
        ctx(),
        { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
        exploding,
      ),
    ).rejects.toThrow('worker died mid-call');

    const r = await db
      .prepare(`SELECT status, template_key, to_email FROM email_messages WHERE idempotency_key = ?`)
      .bind(k)
      .first<{ status: string; template_key: string; to_email: string }>();
    expect(r).not.toBeNull();
    expect(r!.status).toBe('queued');
    expect(r!.template_key).toBe('sign_in_link');
  });

  it('wires env -> transportFor -> resendTransport with the configured key', async () => {
    // The production path, executed end to end with an injected fetcher so no
    // network is involved. Previously nothing ran it: sendEmail defaulted to
    // transportFor(env) and every test overrode that default.
    let auth = '';
    const fake: typeof fetch = async (_u, init) => {
      auth = (init!.headers as Record<string, string>).authorization ?? '';
      return new Response('{"id":"p"}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const t = transportFor(mailEnv({ RESEND_API_KEY: 'secret-from-wrangler' }), fake);
    expect(t).not.toBeNull();

    const out = await sendEmail(
      mailEnv({ RESEND_API_KEY: 'secret-from-wrangler' }),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      t,
    );
    expect(out.status).toBe('sent');
    expect(auth).toBe('Bearer secret-from-wrangler');
  });

  it('an env without an API key produces no transport at all', () => {
    expect(transportFor(mailEnv({ RESEND_API_KEY: undefined }))).toBeNull();
    expect(transportFor(mailEnv({ RESEND_API_KEY: '   ' }))).toBeNull();
    expect(transportFor(mailEnv({ RESEND_API_KEY: 'k' }))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('idempotency', () => {
  it('a second call with the same key sends nothing more', async () => {
    const { sent, transport } = recorder();
    const k = key();
    const first = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    const second = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );

    expect(sent).toHaveLength(1);
    expect(second.deduplicated).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.status).toBe('sent');

    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key = ?`)
      .bind(k)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('two concurrent calls with one key deliver once', async () => {
    const { sent, transport } = recorder();
    const k = key();
    const results = await Promise.all([
      sendEmail(mailEnv(), ctx(), { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k }, transport),
      sendEmail(mailEnv(), ctx(), { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k }, transport),
    ]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(1);
  });

  it('refuses a key already held by a different recipient', async () => {
    // Without this, a key derived from an entity alone -- application_received
    // for an application with two contacts -- silently drops the second copy
    // and reports 'sent'. The system says we emailed them, the row says we
    // emailed them, and nobody did.
    const { sent, transport } = recorder();
    const k = key();
    const base = { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, idempotencyKey: k };
    await sendEmail(mailEnv(), ctx(), { ...base, to: 'first@example.org' }, transport);
    await expect(
      sendEmail(mailEnv(), ctx(), { ...base, to: 'second@example.org' }, transport),
    ).rejects.toThrow(/already belongs to a different message/);
    expect(sent).toHaveLength(1);
  });

  it('refuses a key already held by a different template', async () => {
    const { sent, transport } = recorder();
    const k = key();
    await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    await expect(
      sendEmail(
        mailEnv(), ctx(),
        { template: APPLICATION_RECEIVED, vars: RECEIVED_VARS, to: 'a@example.org', idempotencyKey: k },
        transport,
      ),
    ).rejects.toThrow(/already belongs to a different message/);
    expect(sent).toHaveLength(1);
  });

  it('reports a deduplicated failure as failed, not as sent', async () => {
    const { transport } = recorder({ ok: false, code: 'PROVIDER_500', message: 'boom' });
    const k = key();
    const opts = { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k };
    await sendEmail(mailEnv(), ctx(), opts, transport);
    const second = await sendEmail(mailEnv(), ctx(), opts, transport);
    expect(second.deduplicated).toBe(true);
    expect(second.status).toBe('failed');
    expect(second.errorCode).toBe('PROVIDER_500');
  });

  it('a different key to the same person is a different message', async () => {
    const { sent, transport } = recorder();
    const opts = { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org' };
    await sendEmail(mailEnv(), ctx(), { ...opts, idempotencyKey: key() }, transport);
    await sendEmail(mailEnv(), ctx(), { ...opts, idempotencyKey: key() }, transport);
    expect(sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('self-healing: a crash must not suppress a message forever', () => {
  /** Leave a real stranded row: claimed, then the transport dies. */
  async function strand(k: string, to = 'a@example.org') {
    await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to, idempotencyKey: k },
      { async send() { throw new Error('worker died mid-call'); } },
    ).catch(() => undefined);
    const r = await db
      .prepare(`SELECT id, status FROM email_messages WHERE idempotency_key = ?`)
      .bind(k).first<{ id: string; status: string }>();
    expect(r!.status).toBe('queued');
    return r!.id;
  }

  /** Backdate the row rather than fake a clock, so the real comparison runs. */
  async function age(id: string, ms: number) {
    await db
      .prepare(`UPDATE email_messages SET created_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - ms).toISOString(), id)
      .run();
  }

  it('leaves a freshly queued row alone', async () => {
    // Still inside the window: a live request could be in flight.
    const { sent, transport } = recorder();
    const k = key();
    await strand(k);
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    expect(sent).toHaveLength(0);
    expect(out.deduplicated).toBe(true);
    expect(out.status).toBe('queued');
    expect(out.redriven).toBeUndefined();
  });

  it('re-drives a row stranded past the window, onto the same row', async () => {
    const { sent, transport } = recorder();
    const k = key();
    const id = await strand(k);
    await age(id, REDRIVE_AFTER_MS + 1000);

    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    expect(sent).toHaveLength(1);
    expect(out.redriven).toBe(true);
    expect(out.deduplicated).toBe(false);
    expect(out.status).toBe('sent');
    expect(out.messageId).toBe(id); // the stranded row settles, not a new one

    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE idempotency_key = ?`)
      .bind(k).first<{ n: number }>();
    expect(rows!.n).toBe(1);
    expect((await row(id))!.status).toBe('sent');
  });

  it('sends the provider the ORIGINAL key, so the provider suppresses a duplicate', async () => {
    // This is what makes self-healing safe: if the provider accepted the first
    // call before the crash, its own 24-hour idempotency window drops ours.
    const { sent, transport } = recorder();
    const k = key();
    const id = await strand(k);
    await age(id, REDRIVE_AFTER_MS + 1000);
    await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    expect(sent[0]!.idempotencyKey).toBe(k);
  });

  it('two simultaneous re-drives deliver once', async () => {
    const { sent, transport } = recorder();
    const k = key();
    const id = await strand(k);
    await age(id, REDRIVE_AFTER_MS + 1000);

    const opts = { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k };
    const results = await Promise.all([
      sendEmail(mailEnv(), ctx(), opts, transport),
      sendEmail(mailEnv(), ctx(), opts, transport),
    ]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.redriven)).toHaveLength(1);
  });

  it('never re-drives a settled row, however old', async () => {
    // Only 'queued' is stranded. An old 'sent' row is a delivered message.
    //
    // Note the row is INSERTed already-old rather than backdated: the terminal
    // trigger refuses every update to a settled row, not merely a status
    // change, so a settled row cannot be aged even by a test. That is the
    // property working, so the test works around it rather than weakening it.
    const { sent, transport } = recorder();
    const k = key();
    const ancient = new Date(Date.now() - REDRIVE_AFTER_MS * 100).toISOString();
    await db
      .prepare(
        `INSERT INTO email_messages (id, idempotency_key, template_key, to_email, subject,
           status, provider, sent_at, created_at, updated_at)
         VALUES (?,?,?,?,?,'sent','resend',?,?,?)`,
      )
      .bind(crypto.randomUUID(), k, 'sign_in_link', 'a@example.org', 'Your sign-in link',
            ancient, ancient, ancient)
      .run();

    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    expect(sent).toHaveLength(0);
    expect(out.deduplicated).toBe(true);
    expect(out.status).toBe('sent');
    expect(out.redriven).toBeUndefined();
  });

  it('never re-drives an old failed row either', async () => {
    // A failure is a settled outcome with a diagnosis. Re-driving it would
    // silently retry something a human has not looked at yet.
    const { sent, transport } = recorder();
    const k = key();
    const ancient = new Date(Date.now() - REDRIVE_AFTER_MS * 100).toISOString();
    await db
      .prepare(
        `INSERT INTO email_messages (id, idempotency_key, template_key, to_email, subject,
           status, provider, error_code, created_at, updated_at)
         VALUES (?,?,?,?,?,'failed','resend','PROVIDER_422',?,?)`,
      )
      .bind(crypto.randomUUID(), k, 'sign_in_link', 'a@example.org', 'Your sign-in link',
            ancient, ancient)
      .run();

    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      transport,
    );
    expect(sent).toHaveLength(0);
    expect(out.status).toBe('failed');
    expect(out.redriven).toBeUndefined();
  });

  it('still refuses a re-drive aimed at a different recipient', async () => {
    // The identity check runs before the re-drive, so a stranded row cannot be
    // hijacked into delivering to someone else.
    const { sent, transport } = recorder();
    const k = key();
    const id = await strand(k, 'first@example.org');
    await age(id, REDRIVE_AFTER_MS + 1000);
    await expect(
      sendEmail(
        mailEnv(), ctx(),
        { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'second@example.org', idempotencyKey: k },
        transport,
      ),
    ).rejects.toThrow(/already belongs to a different message/);
    expect(sent).toHaveLength(0);
  });

  it('treats an unreadable timestamp as not redrivable', () => {
    // A corrupt row is not a licence to send. A message that never goes out is
    // a visible stuck row; a duplicate is in somebody's inbox.
    expect(isRedrivable('not-a-date')).toBe(false);
    expect(isRedrivable('')).toBe(false);
  });

  it('uses a window inside the provider dedupe window and outside a live request', () => {
    expect(REDRIVE_AFTER_MS).toBe(10 * 60 * 1000);
    expect(REDRIVE_AFTER_MS).toBeGreaterThan(PROVIDER_TIMEOUT_MS * 10);
    expect(REDRIVE_AFTER_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('is inclusive at the boundary', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const exactly = new Date(now.getTime() - REDRIVE_AFTER_MS).toISOString();
    const oneMsShort = new Date(now.getTime() - REDRIVE_AFTER_MS + 1).toISOString();
    expect(isRedrivable(exactly, now)).toBe(true);
    expect(isRedrivable(oneMsShort, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the database refuses to lose a send record', () => {
  it('a settled message cannot change status', async () => {
    const { transport } = recorder();
    const out = await sendEmail(
      mailEnv(),
      ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      transport,
    );
    await expect(
      db.prepare(`UPDATE email_messages SET status='failed', error_code='X', sent_at=NULL WHERE id=?`)
        .bind(out.messageId).run(),
    ).rejects.toThrow(/settled message cannot change status/);
  });

  it('a row cannot be deleted', async () => {
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      null,
    );
    await expect(
      db.prepare(`DELETE FROM email_messages WHERE id=?`).bind(out.messageId).run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('the idempotency key cannot be edited to free it for reuse', async () => {
    const k = key();
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: k },
      null,
    );
    await expect(
      db.prepare(`UPDATE email_messages SET idempotency_key='freed' WHERE id=?`).bind(out.messageId).run(),
    ).rejects.toThrow(/idempotency_key cannot change/);
  });

  it('INSERT OR REPLACE cannot destroy a settled row by colliding on its key', async () => {
    // The hole 0007 left open: idempotency_key is a SECOND unique index, and a
    // REPLACE colliding there deletes the owning row without firing
    // BEFORE DELETE. One statement hard-deleted a send record, freed its key,
    // and raised no error.
    const k = key();
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'victim@example.org', idempotencyKey: k },
      null,
    );
    await expect(
      db.prepare(
        `INSERT OR REPLACE INTO email_messages (id, idempotency_key, template_key, to_email,
           subject, status, created_at, updated_at) VALUES (?,?,?,?,?,'queued',?,?)`,
      ).bind(crypto.randomUUID(), k, 'attacker', 'evil@example.org', 's', '2026-01-01', '2026-01-01').run(),
    ).rejects.toThrow(/already claimed/);

    const survivor = await row(out.messageId);
    expect(survivor).not.toBeNull();
    expect(survivor!.to_email).toBe('victim@example.org');
    expect(survivor!.status).toBe('suppressed');
  });

  it('a queued row cannot have its recipient or releaser rewritten', async () => {
    const out = await sendEmail(
      mailEnv(), ctx(),
      { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() },
      { async send() { throw new Error('left queued'); } },
    ).catch(() => null);
    void out;
    const queued = await db
      .prepare(`SELECT id FROM email_messages WHERE status='queued' LIMIT 1`)
      .first<{ id: string }>();
    await expect(
      db.prepare(`UPDATE email_messages SET to_email='attacker@example.org' WHERE id=?`)
        .bind(queued!.id).run(),
    ).rejects.toThrow(/frozen/);
  });

  it('a failed row must say why', async () => {
    await expect(
      db.prepare(
        `INSERT INTO email_messages (id, idempotency_key, template_key, to_email, subject,
           status, created_at, updated_at) VALUES (?,?,?,?,?,'failed',?,?)`,
      ).bind(crypto.randomUUID(), key(), 't', 'a@example.org', 's', '2026-01-01', '2026-01-01').run(),
    ).rejects.toThrow();
  });

  it('only a sent row may carry a send time', async () => {
    await expect(
      db.prepare(
        `INSERT INTO email_messages (id, idempotency_key, template_key, to_email, subject,
           status, sent_at, created_at, updated_at) VALUES (?,?,?,?,?,'suppressed',?,?,?)`,
      ).bind(crypto.randomUUID(), key(), 't', 'a@example.org', 's', '2026-01-01', '2026-01-01', '2026-01-01').run(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('the decline rule is enforced by the send path', () => {
  // A fixture rather than a real template: no decline copy exists yet, and
  // inventing applicant-facing wording to satisfy a test is how placeholder
  // prose ends up in front of a nonprofit.
  const RELEASE_REQUIRED: EmailTemplate<{ name: string }> = {
    key: 'test_requires_release',
    requiresHumanRelease: true,
    render: (v) => ({ subject: 'x', text: v.name, html: `<p>${escapeHtml(v.name)}</p>` }),
  };

  it('refuses to send without a named releaser', async () => {
    const { sent, transport } = recorder();
    await expect(
      sendEmail(
        mailEnv(), ctx(),
        { template: RELEASE_REQUIRED, vars: { name: 'A' }, to: 'a@example.org', idempotencyKey: key() },
        transport,
      ),
    ).rejects.toThrow(/requires a human release/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a releaser that is only whitespace', async () => {
    // Truthiness is not enough: '   ' recorded in released_by_user_id is an
    // audit row that resolves to nobody.
    const { sent, transport } = recorder();
    await expect(
      sendEmail(
        mailEnv(), ctx(),
        { template: RELEASE_REQUIRED, vars: { name: 'A' }, to: 'a@example.org',
          idempotencyKey: key(), releasedByUserId: '   ' },
        transport,
      ),
    ).rejects.toThrow(/requires a human release/);
    expect(sent).toHaveLength(0);
  });

  it('sends once a person is named, and records who', async () => {
    const { sent, transport } = recorder();
    const out = await sendEmail(
      mailEnv(), ctx(),
      {
        template: RELEASE_REQUIRED, vars: { name: 'A' }, to: 'a@example.org',
        idempotencyKey: key(), releasedByUserId: 'user-42',
      },
      transport,
    );
    expect(sent).toHaveLength(1);
    expect((await row(out.messageId))!.released_by_user_id).toBe('user-42');
  });
});

// ---------------------------------------------------------------------------
describe('inputs that must be refused', () => {
  const bad = ['', '   ', 'not-an-address', 'a@b', 'a b@example.org', 'a@example.org, b@example.org'];
  for (const to of bad) {
    it(`refuses ${JSON.stringify(to)}`, async () => {
      const { sent, transport } = recorder();
      await expect(
        sendEmail(mailEnv(), ctx(), { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to, idempotencyKey: key() }, transport),
      ).rejects.toThrow(/not deliverable/);
      expect(sent).toHaveLength(0);
    });
  }

  it('refuses an empty idempotency key', async () => {
    const { transport } = recorder();
    await expect(
      sendEmail(mailEnv(), ctx(), { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: '  ' }, transport),
    ).rejects.toThrow(/idempotency key is required/);
  });

  it('refuses to send with no from address configured', async () => {
    const { transport } = recorder();
    await expect(
      sendEmail(mailEnv({ EMAIL_FROM: '' }), ctx(), { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org', idempotencyKey: key() }, transport),
    ).rejects.toThrow(/EMAIL_FROM is not configured/);
  });

  it('a template refuses a URL the client would execute', () => {
    expect(() =>
      SIGN_IN_LINK.render({ ...SIGN_IN_VARS, url: 'javascript:alert(1)' }),
    ).toThrow(/not http/);
  });
});

// ---------------------------------------------------------------------------
describe('templates', () => {
  /**
   * One fixture per registered template, keyed by template key.
   *
   * The previous version of this test looped over TEMPLATES but re-derived the
   * render from a hardcoded ternary, so any template that was not
   * sign_in_link fell into the else branch and was "checked" by re-rendering
   * a different template. A third template with an empty subject, no
   * plain-text body, no doctype and an emoji in it passed. This map has no
   * else branch: a new template with no fixture fails outright.
   */
  const FIXTURES: Record<string, unknown> = {
    sign_in_link: SIGN_IN_VARS,
    application_received: RECEIVED_VARS,
    sign_in_problem: {
      reason: 'ambiguous_organization',
      supportEmail: 'grants@example.org',
      destination: 'Inspire Change application',
    },
  };

  it('every registered template renders a subject, a text body and HTML', () => {
    const keys = Object.keys(TEMPLATES);
    expect(keys.length).toBeGreaterThan(0);

    for (const k of keys) {
      const t = TEMPLATES[k as keyof typeof TEMPLATES] as EmailTemplate<unknown>;
      expect(t.key).toBe(k);
      const fixture = FIXTURES[k];
      expect(fixture, `no fixture for template '${k}' -- add one`).toBeDefined();

      // The registered object is rendered, not a stand-in for it.
      const r = t.render(fixture);
      expect(r.subject.trim().length, `${k}: empty subject`).toBeGreaterThan(0);
      expect(r.subject).not.toMatch(/TODO|TBD|placeholder|lorem/i);
      expect(r.text.trim().length, `${k}: empty text body`).toBeGreaterThan(0);
      expect(r.html, `${k}: no doctype`).toContain('<!doctype html>');
      // No emoji anywhere in the interface, per CLAUDE.md.
      expect(
        /\p{Extended_Pictographic}/u.test(r.subject + r.text + r.html),
        `${k}: contains an emoji`,
      ).toBe(false);
    }
  });

  it('names the destination in the subject, for a shared inbox', () => {
    // "Your sign-in link" alone, in an info@ inbox three people watch, reads
    // as something to archive.
    const r = SIGN_IN_LINK.render(SIGN_IN_VARS);
    expect(r.subject).toBe('Sign in to your Inspire Change application');
  });

  it('does not claim the link is unusable by anyone else, because it is not', () => {
    // Forwarding the email hands over the ability to sign in -- and forwarding
    // to whoever is the authorized signer is an ordinary thing to do. The old
    // footer said "Nobody can use the link without this email".
    const r = SIGN_IN_LINK.render(SIGN_IN_VARS);
    for (const body of [r.text, r.html]) {
      expect(body).not.toContain('Nobody can use the link');
      expect(body).toContain('like a password');
    }
  });

  it('lets an applicant tell two sign-in emails apart, and recover from a stale one', () => {
    const r = SIGN_IN_LINK.render(SIGN_IN_VARS);
    for (const body of [r.text, r.html]) {
      expect(body).toContain('March 1, 2026 at 9:12 PM CST');
      expect(body).toContain('https://applications.example.org/sign-in');
    }
  });

  it('tells the applicant when to expect a decision, when the cycle knows', () => {
    const withDate = APPLICATION_RECEIVED.render({
      ...RECEIVED_VARS,
      decisionByDisplay: 'mid-April 2026',
    });
    expect(withDate.text).toContain('by mid-April 2026');
    expect(withDate.html).toContain('by mid-April 2026');

    // And degrades cleanly when it does not.
    const without = APPLICATION_RECEIVED.render(RECEIVED_VARS);
    expect(without.text).toContain('We will be in touch about a decision.');
  });

  it('escapes applicant-supplied text in the HTML body', () => {
    const r = APPLICATION_RECEIVED.render(RECEIVED_VARS);
    expect(r.html).toContain('Bayou Reach Collective &amp; Friends');
    expect(r.html).not.toContain('<all>');
    expect(r.html).toContain('&lt;all&gt;');
    // The plain-text body is not HTML and must keep the applicant's own text.
    expect(r.text).toContain('Literacy for <all>');
  });

  it('reads back every answer, and says so when one is blank', () => {
    const r = APPLICATION_RECEIVED.render(RECEIVED_VARS);
    for (const a of RECEIVED_VARS.answers) {
      expect(r.text).toContain(a.label);
      expect(r.html).toContain(a.label);
    }
    expect(r.text).toContain('(not answered)');
    expect(r.html).toContain('Not answered');
    // Sections appear once each, in the order the answers arrived.
    expect(r.text.indexOf('Organization')).toBeLessThan(r.text.indexOf('Your request'));
    expect(r.text.match(/--- Organization ---/g)).toHaveLength(1);
  });

  it('keeps a multi-line answer readable in both bodies', () => {
    const r = APPLICATION_RECEIVED.render(RECEIVED_VARS);
    expect(r.text).toContain('Harris County\nFort Bend County');
    expect(r.html).toContain('Harris County<br>Fort Bend County');
  });

  it('escapes every interpolation site, not just the two that were tested', () => {
    // Escaping was only pinned at fact values and answer values. Un-escaping
    // the label, section title, <title>, preheader, button label or the
    // sign-in destination each left the whole suite green -- and labels and
    // section titles come from admin-entered form_fields/form_sections rows.
    const XSS = '</p><script>alert(1)</script>';

    const received = APPLICATION_RECEIVED.render({
      ...RECEIVED_VARS,
      programName: XSS, // reaches the heading, the preview line, and a block
      confirmationCode: XSS, // reaches the preheader
      answers: [{ section: XSS, label: XSS, value: XSS }],
    });
    expect(received.html).not.toContain('<script>');
    expect(received.html).toContain('&lt;script&gt;');

    const signIn = SIGN_IN_LINK.render({ ...SIGN_IN_VARS, destination: XSS });
    expect(signIn.html).not.toContain('<script>');
    expect(signIn.html).toContain('&lt;script&gt;');
  });

  it('escapeHtml closes the attribute-breaking characters', () => {
    expect(escapeHtml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;');
  });
});

// ---------------------------------------------------------------------------
describe('the Resend transport itself', () => {
  const msg: OutboundEmail = {
    to: 'a@example.org', from: 'b@example.org', subject: 's',
    text: 't', html: '<p>t</p>', idempotencyKey: 'k-1',
  };

  it('sends the fields and headers Resend expects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: 'resend-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const res = await resendTransport('secret-key', fake).send({ ...msg, replyTo: 'r@example.org' });
    expect(res).toEqual({ ok: true, providerMessageId: 'resend-1' });

    const h = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe('https://api.resend.com/emails');
    expect(seen!.init.method).toBe('POST'); // Resend's /emails rejects anything else.
    expect(h.authorization).toBe('Bearer secret-key');
    expect(h['content-type']).toBe('application/json');
    expect(h['idempotency-key']).toBe('k-1');
    // Exact, not toMatchObject: a subset matcher let `html` or `text` be
    // dropped from the payload entirely with the suite still green, and an
    // email with no plain-text body is one CLAUDE.md requires us not to send.
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      from: 'b@example.org',
      to: ['a@example.org'],
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      reply_to: ['r@example.org'],
    });
  });

  it('omits reply_to entirely when there is none', async () => {
    let body: Record<string, unknown> = {};
    const fake: typeof fetch = async (_u, init) => {
      body = JSON.parse(init!.body as string);
      return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await resendTransport('k', fake).send(msg);
    expect('reply_to' in body).toBe(false);
  });

  it('reports a rejection with its status and body', async () => {
    const fake: typeof fetch = async () => new Response('{"message":"domain not verified"}', { status: 403 });
    const res = await resendTransport('k', fake).send(msg);
    expect(res).toEqual({ ok: false, code: 'PROVIDER_403', message: '{"message":"domain not verified"}' });
  });

  it('still gives a diagnosis when the error body is empty', async () => {
    // The fallback chain exists precisely for this case, and dropping it left
    // the suite green: a failed row would record a blank reason.
    const fake: typeof fetch = async () => new Response('', { status: 429, statusText: 'Too Many Requests' });
    expect(await resendTransport('k', fake).send(msg)).toEqual({
      ok: false, code: 'PROVIDER_429', message: 'Too Many Requests',
    });
  });

  it('actually aborts a hung provider through its AbortController', async () => {
    // The synthetic AbortError test below proves the code path is mapped, not
    // that the timeout is wired: shortening PROVIDER_TIMEOUT_MS to 1ms left
    // the suite green while every real send would have aborted instantly.
    // This drives the real controller with a fetcher that hangs until aborted.
    const hanging: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const res = await resendTransport('k', hanging, 20).send(msg);
    expect(res).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
  });

  it('gives a hung provider ten seconds by default', () => {
    // Pins the constant itself; the test above pins the mechanism.
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
  });

  it('reports a timeout distinctly from an unreachable provider', async () => {
    // Nothing exercised the abort path, so PROVIDER_TIMEOUT was unreachable by
    // test and the whole AbortController could be deleted silently.
    const fake: typeof fetch = async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    expect(await resendTransport('k', fake).send(msg)).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT' });
  });

  it('passes the API key through to the authorization header', async () => {
    let auth = '';
    const fake: typeof fetch = async (_u, init) => {
      auth = (init!.headers as Record<string, string>).authorization ?? '';
      return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await resendTransport('key-from-the-secret', fake).send(msg);
    expect(auth).toBe('Bearer key-from-the-secret');
  });

  it('survives an error page that is not JSON', async () => {
    const fake: typeof fetch = async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const res = await resendTransport('k', fake).send(msg);
    expect(res).toMatchObject({ ok: false, code: 'PROVIDER_502' });
  });

  it('survives a 200 whose body is not JSON', async () => {
    const fake: typeof fetch = async () => new Response('OK', { status: 200 });
    expect(await resendTransport('k', fake).send(msg)).toEqual({ ok: true, providerMessageId: null });
  });

  it('reports an unreachable provider rather than throwing', async () => {
    const fake: typeof fetch = async () => { throw new TypeError('network error'); };
    expect(await resendTransport('k', fake).send(msg)).toMatchObject({ ok: false, code: 'PROVIDER_UNREACHABLE' });
  });
});
