/**
 * Email templates.
 *
 * A template is a pure function from typed variables to a subject, a plain-text
 * body, and an HTML body. It performs no I/O, knows nothing about the provider,
 * and never reaches for a token, a session, or the database. That is what makes
 * the copy reviewable by a non-engineer and testable without a network.
 *
 * TYPE SAFETY IS THE POINT. Each template carries the shape of its own
 * variables, so `sendEmail` cannot be called with a missing or misspelled one.
 * A grant decision email with an empty organization name is not a rendering
 * bug, it is an outgoing letter with a hole in it.
 *
 * DESIGN: light ground, brand palette, no emoji, no images, no external CSS.
 * Inline styles only -- email clients discard <style> blocks unpredictably, and
 * a stylesheet that does not load must still leave a readable letter. Every
 * template must read correctly as plain text alone, because some recipients
 * will only ever see that version.
 */

/** Brand palette. Kept here rather than imported: this file must stay pure. */
const INK = '#021018';
const INK_SOFT = '#4a555e';
const BLUE = '#0075b5'; // Brand blue darkened to clear 4.5:1 on white.
const RULE = '#d7dde2';
const PAPER = '#ffffff';
const GROUND = '#f4f6f8';

/**
 * Escape text for HTML.
 *
 * Every variable interpolated into an HTML body goes through this. Organization
 * names are supplied by applicants and routinely contain an ampersand; they can
 * contain anything at all. An unescaped name is a broken letter at best and an
 * injection into whatever renders the mail at worst.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A URL safe to place in an href.
 *
 * Escaping is not enough for an attribute that the client will follow: a
 * `javascript:` value survives HTML escaping intact. Templates receive URLs
 * from calling code, but a template is the last place that can refuse one.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('email template: refusing a URL that is not http(s)');
  }
  return escapeHtml(trimmed);
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailTemplate<V> {
  /** Stable key, recorded on every send. Never reused for different copy. */
  key: string;
  /**
   * This template may never be sent by a machine decision alone.
   *
   * CLAUDE.md: decline emails are always human-reviewed before send. sendEmail
   * refuses a template with this set unless the caller names the person who
   * released it, so the rule is enforced by the send path rather than by
   * whoever remembers to check.
   */
  requiresHumanRelease?: boolean;
  render(vars: V): RenderedEmail;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LayoutParts {
  /** Preheader: the grey line clients show next to the subject in the list. */
  preview: string;
  heading: string;
  /** Body blocks, already HTML-escaped by the caller. */
  blocks: string[];
  action?: { label: string; url: string };
  /**
   * Plain text. Escaped here, unlike `blocks`, because a footer is a sentence
   * rather than markup -- and the moment one carries an organization name, an
   * unescaped footer is an injection with nothing to catch it.
   */
  footer: string;
}

function layout(parts: LayoutParts): string {
  const action = parts.action
    ? `
        <tr><td style="padding:8px 0 24px 0;">
          <a href="${safeUrl(parts.action.url)}"
             style="display:inline-block;background:${BLUE};color:${PAPER};
                    text-decoration:none;font-weight:600;font-size:16px;
                    padding:14px 24px;border-radius:6px;">${escapeHtml(parts.action.label)}</a>
        </td></tr>`
    : '';

  // Tables, not flexbox. Outlook renders neither modern CSS nor a bare <div>
  // centred, and this letter has to survive whatever the recipient opens it in.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(parts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${GROUND};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(parts.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${GROUND};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:560px;background:${PAPER};border:1px solid ${RULE};border-radius:8px;">
      <tr><td style="background:${INK};padding:20px 28px;border-radius:8px 8px 0 0;">
        <span style="color:${PAPER};font-family:Arial,Helvetica,sans-serif;
                     font-size:15px;font-weight:700;letter-spacing:0.02em;">Houston Texans Foundation</span>
      </td></tr>
      <tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;color:${INK};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:0 0 12px 0;">
            <h1 style="margin:0;font-size:21px;line-height:1.3;color:${INK};">${escapeHtml(parts.heading)}</h1>
          </td></tr>
          ${parts.blocks
            .map(
              (b) =>
                `<tr><td style="padding:0 0 14px 0;font-size:15px;line-height:1.55;color:${INK};">${b}</td></tr>`,
            )
            .join('\n          ')}
          ${action}
        </table>
      </td></tr>
      <tr><td style="padding:16px 28px 22px 28px;border-top:1px solid ${RULE};
                     font-family:Arial,Helvetica,sans-serif;font-size:13px;
                     line-height:1.5;color:${INK_SOFT};">${escapeHtml(parts.footer)}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Wrap plain text at a sane width. Some clients do not wrap at all. */
function textBlock(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// sign_in_link
// ---------------------------------------------------------------------------

export interface SignInLinkVars {
  /** Fully-formed sign-in URL. Token construction belongs to the auth module. */
  url: string;
  /** Minutes until the link stops working. Stated so the recipient is not surprised. */
  expiresInMinutes: number;
  /** Where the recipient is signing in, e.g. 'Inspire Change application'. */
  destination: string;
}

/**
 * The sign-in link.
 *
 * This template deliberately does not know how tokens work. It is handed a
 * finished URL, which keeps token construction, hashing and expiry in one place
 * (the auth module) instead of leaking into copy that a non-engineer edits.
 */
export const SIGN_IN_LINK: EmailTemplate<SignInLinkVars> = {
  key: 'sign_in_link',
  render(v) {
    const mins = `${v.expiresInMinutes} minute${v.expiresInMinutes === 1 ? '' : 's'}`;
    return {
      subject: 'Your sign-in link',
      text: textBlock([
        `Use this link to sign in to your ${v.destination}:`,
        '',
        v.url,
        '',
        `The link works once and expires in ${mins}.`,
        '',
        'If you did not ask to sign in, you can ignore this message. Nobody can',
        'use the link without this email.',
      ]),
      html: layout({
        preview: `Your sign-in link, valid for ${mins}.`,
        heading: 'Your sign-in link',
        blocks: [
          `Use the button below to sign in to your ${escapeHtml(v.destination)}.`,
          `<span style="color:${INK_SOFT};">The link works once and expires in ${escapeHtml(mins)}.</span>`,
        ],
        action: { label: 'Sign in', url: v.url },
        footer:
          'If you did not ask to sign in, you can ignore this message. Nobody can use the link without this email.',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// application_received
// ---------------------------------------------------------------------------

export interface AnswerLine {
  /** Section heading the answer sat under. */
  section: string;
  /** The label as it read when the applicant answered it. */
  label: string;
  /** Already formatted for display: money as dollars, dates in Central time. */
  value: string;
}

export interface ApplicationReceivedVars {
  organizationName: string;
  programName: string;
  projectTitle: string;
  /** Formatted at the display edge by the caller. Cents never reach a template. */
  requestedAmount: string;
  submittedAtDisplay: string;
  confirmationCode: string;
  /**
   * The full read-back. CLAUDE.md step 10: the applicant gets a record of
   * everything they submitted without logging back in.
   */
  answers: AnswerLine[];
}

export const APPLICATION_RECEIVED: EmailTemplate<ApplicationReceivedVars> = {
  key: 'application_received',
  render(v) {
    const facts: Array<[string, string]> = [
      ['Organization', v.organizationName],
      ['Program', v.programName],
      ['Project', v.projectTitle],
      ['Amount requested', v.requestedAmount],
      ['Submitted', v.submittedAtDisplay],
      ['Confirmation', v.confirmationCode],
    ];

    // Group the read-back by section, preserving the order it arrived in, so
    // the letter reads in the same order as the form the applicant filled in.
    const sections: Array<{ title: string; lines: AnswerLine[] }> = [];
    for (const line of v.answers) {
      const last = sections[sections.length - 1];
      if (last && last.title === line.section) last.lines.push(line);
      else sections.push({ title: line.section, lines: [line] });
    }

    const text = textBlock([
      `We have received your application to ${v.programName}.`,
      '',
      ...facts.map(([k, val]) => `${k}: ${val}`),
      '',
      'A copy of everything you submitted follows, so you have a record',
      'without signing back in.',
      '',
      ...sections.flatMap((s) => [
        `--- ${s.title} ---`,
        ...s.lines.flatMap((l) => [`${l.label}:`, l.value === '' ? '(not answered)' : l.value, '']),
      ]),
      'You do not need to do anything else. We will be in touch about a',
      'decision. Replying to this message reaches a real person.',
    ]);

    const answersHtml = sections
      .map(
        (s) => `
          <p style="margin:18px 0 8px 0;font-size:13px;font-weight:700;
                    text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};">${escapeHtml(s.title)}</p>
          ${s.lines
            .map(
              (l) => `<p style="margin:0 0 10px 0;font-size:14px;line-height:1.5;">
                <span style="color:${INK_SOFT};">${escapeHtml(l.label)}</span><br>
                ${
                  l.value === ''
                    ? `<span style="color:${INK_SOFT};">Not answered</span>`
                    : escapeHtml(l.value).replace(/\n/g, '<br>')
                }
              </p>`,
            )
            .join('\n          ')}`,
      )
      .join('\n');

    return {
      subject: `We received your ${v.programName} application`,
      text,
      html: layout({
        preview: `Confirmation ${v.confirmationCode}. A copy of your application is below.`,
        heading: 'We received your application',
        blocks: [
          `Thank you. Your application to ${escapeHtml(v.programName)} is submitted.`,
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                  style="border:1px solid ${RULE};border-radius:6px;">
             ${facts
               .map(
                 ([k, val]) => `<tr>
                   <td style="padding:8px 12px;font-size:14px;color:${INK_SOFT};width:42%;">${escapeHtml(k)}</td>
                   <td style="padding:8px 12px;font-size:14px;color:${INK};">${escapeHtml(val)}</td>
                 </tr>`,
               )
               .join('\n             ')}
           </table>`,
          `<span style="color:${INK_SOFT};">A copy of everything you submitted is below, so you have a record without signing back in.</span>`,
          answersHtml,
        ],
        footer:
          'You do not need to do anything else. We will be in touch about a decision. Replying to this message reaches a real person.',
      }),
    };
  },
};

/**
 * Every template the system can send.
 *
 * Enumerated so tests can assert properties across all of them at once -- a new
 * template that forgets a plain-text body, or reuses a key, fails the suite
 * rather than reaching a recipient.
 */
export const TEMPLATES = {
  [SIGN_IN_LINK.key]: SIGN_IN_LINK,
  [APPLICATION_RECEIVED.key]: APPLICATION_RECEIVED,
} as const;
