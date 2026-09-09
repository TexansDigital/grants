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

const SIGN_IN_VARS = {
  url: 'https://grants.example.org/signin?t=abc',
  expiresInMinutes: 15,
  destination: 'Inspire Change application',
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

    const r = await row(out.messageId);
    expect(r!.status).toBe('sent');
    expect(r!.template_key).toBe('sign_in_link');
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
    expect(serialized).not.toContain('signin?t=abc');
    expect(serialized).not.toContain('abc');
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

  it('a different key to the same person is a different message', async () => {
    const { sent, transport } = recorder();
    const opts = { template: SIGN_IN_LINK, vars: SIGN_IN_VARS, to: 'a@example.org' };
    await sendEmail(mailEnv(), ctx(), { ...opts, idempotencyKey: key() }, transport);
    await sendEmail(mailEnv(), ctx(), { ...opts, idempotencyKey: key() }, transport);
    expect(sent).toHaveLength(2);
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
  it('every registered template renders a subject, a text body and HTML', () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      expect(t.key).toBe(key);
      const r =
        t.key === 'sign_in_link'
          ? SIGN_IN_LINK.render(SIGN_IN_VARS)
          : APPLICATION_RECEIVED.render(RECEIVED_VARS);
      expect(r.subject.length).toBeGreaterThan(0);
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(r.html).toContain('<!doctype html>');
      // No emoji anywhere in the interface, per CLAUDE.md.
      expect(/\p{Extended_Pictographic}/u.test(r.subject + r.text + r.html)).toBe(false);
    }
  });

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
    expect(h.authorization).toBe('Bearer secret-key');
    expect(h['idempotency-key']).toBe('k-1');
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ from: 'b@example.org', to: ['a@example.org'], subject: 's', reply_to: ['r@example.org'] });
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
