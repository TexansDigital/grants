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
  /**
   * When this link was requested, already formatted in the applicant's
   * timezone.
   *
   * Somebody who clicks "send me another" ends up with two identical emails,
   * and only the newest link works. Without a visible time there is no way to
   * tell them apart -- and in a threaded view the older one is often on top.
   */
  requestedAtDisplay: string;
  /** Where to go to request a fresh link. Shown for when this one is stale. */
  requestAnotherUrl: string;
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
      // Named, not just "Your sign-in link". This often arrives in a shared
      // inbox that several people watch, where an unattributed sign-in email
      // reads as something to archive.
      subject: `Sign in to your ${v.destination}`,
      text: textBlock([
        `Use this link to sign in to your ${v.destination}:`,
        '',
        v.url,
        '',
        `Requested at ${v.requestedAtDisplay}.`,
        `The link works once and expires ${mins} after it was requested.`,
        '',
        'If it has expired, or if you asked for more than one link and are not',
        'sure which is current, request a fresh one here:',
        v.requestAnotherUrl,
        '',
        // The old wording here said "Nobody can use the link without this
        // email", which is false: forwarding the message hands over the
        // ability to sign in, and forwarding to whoever is the authorized
        // signer is an ordinary thing to do.
        'Treat this link like a password: anyone who can read this email can',
        'use it. If you did not ask to sign in, you can ignore this message.',
      ]),
      html: layout({
        preview: `Requested at ${v.requestedAtDisplay}. Valid for ${mins}.`,
        heading: `Sign in to your ${v.destination}`,
        blocks: [
          `Use the button below to sign in to your ${escapeHtml(v.destination)}.`,
          `<span style="color:${INK_SOFT};">Requested at ${escapeHtml(v.requestedAtDisplay)}. ` +
            `The link works once and expires ${escapeHtml(mins)} after it was requested.</span>`,
        ],
        action: { label: 'Sign in', url: v.url },
        footer:
          `If this link has expired, or you asked for more than one and are not sure which is ` +
          `current, request a fresh one at ${v.requestAnotherUrl} . Anyone who can read this ` +
          `email can use the link, so treat it like a password. If you did not ask to sign in, ` +
          `you can ignore this message.`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// sign_in_problem
// ---------------------------------------------------------------------------

export type SignInProblemReason =
  /** The address already has staff access, so it cannot hold an applicant login. */
  | 'staff_account'
  /** The address signs in for a different organization than the EIN given. */
  | 'other_organization'
  /** Two or more live organizations share that EIN. A human has to pick. */
  | 'ambiguous_organization';

export interface SignInProblemVars {
  reason: SignInProblemReason;
  /** Where to write for help. One address, never a form nobody monitors. */
  supportEmail: string;
  /** Where the applicant was trying to get to, e.g. 'Inspire Change application'. */
  destination: string;
}

/**
 * "We could not send you a link, and here is why."
 *
 * WHY THIS TEMPLATE EXISTS AT ALL, which is a security decision rather than a
 * copy one.
 *
 * The eligibility endpoint is public and unauthenticated. It used to answer
 * differently depending on whether an address belonged to staff, belonged to
 * another organization, or had already applied -- which made it an oracle:
 * anyone could type an address and learn from the HTTP status whether it was a
 * Foundation staff account, and type a nonprofit's EIN and learn whether that
 * nonprofit had applied this cycle.
 *
 * Every outcome now returns the same acknowledgement. The explanation travels
 * BY EMAIL, to the address the person typed -- so it reaches the mailbox owner,
 * who is entitled to it, and not the caller, who may be anybody. The cost is
 * that somebody who mistypes their own address gets silence; the alternative
 * was answering questions about other people's accounts to anyone who asked.
 */
export const SIGN_IN_PROBLEM: EmailTemplate<SignInProblemVars> = {
  key: 'sign_in_problem',
  render(v) {
    const explanation: Record<SignInProblemReason, string> = {
      staff_account:
        'This address already has Houston Texans Foundation staff access, and staff sign in ' +
        'a different way. To apply on behalf of a nonprofit, use an address belonging to that ' +
        'organization.',
      other_organization:
        'This address is already registered to a different organization. Each address belongs ' +
        'to one organization, so please use an address for the organization you are applying ' +
        'for.',
      ambiguous_organization:
        'We hold more than one record under that EIN and cannot tell which one is yours. ' +
        'This is our records needing tidying rather than anything wrong with your application.',
    };
    const next: Record<SignInProblemReason, string> = {
      staff_account: 'Try again with an address belonging to the organization.',
      other_organization: 'Try again with an address for this organization.',
      ambiguous_organization: 'Reply to this email and we will sort it out and get you a link.',
    };

    return {
      // Not "Problem with your application" -- nothing is wrong with their
      // application, and that subject line lands badly on a deadline.
      subject: `We could not send your sign-in link`,
      text: textBlock([
        `You asked to start a ${v.destination}, and we could not send you a sign-in link.`,
        '',
        explanation[v.reason],
        '',
        next[v.reason],
        '',
        `If you need help, write to ${v.supportEmail}.`,
        '',
        'If you did not ask to apply, you can ignore this message. Nothing has',
        'been created and nobody has been given access to anything.',
      ]),
      html: layout({
        preview: explanation[v.reason],
        heading: 'We could not send your sign-in link',
        blocks: [
          `You asked to start a ${escapeHtml(v.destination)}, and we could not send you a ` +
            `sign-in link.`,
          escapeHtml(explanation[v.reason]),
          `<strong>${escapeHtml(next[v.reason])}</strong>`,
        ],
        footer:
          `If you need help, write to ${escapeHtml(v.supportEmail)}. If you did not ask to ` +
          `apply, you can ignore this message — nothing has been created and nobody has been ` +
          `given access to anything.`,
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
   * When a decision is expected, already formatted. Optional because a cycle
   * may not have set one.
   *
   * "We will be in touch" is the sentence that generates the status-check
   * emails. The cycle already knows its decision date.
   */
  decisionByDisplay?: string;
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
      v.decisionByDisplay
        ? `You do not need to do anything else. We will be in touch by ${v.decisionByDisplay}.`
        : 'You do not need to do anything else. We will be in touch about a decision.',
      'Replying to this message reaches a real person.',
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
        footer: v.decisionByDisplay
          ? `You do not need to do anything else — we will be in touch by ${v.decisionByDisplay}. Replying to this message reaches a real person.`
          : 'You do not need to do anything else. We will be in touch about a decision. Replying to this message reaches a real person.',
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
  [SIGN_IN_PROBLEM.key]: SIGN_IN_PROBLEM,
  [SIGN_IN_LINK.key]: SIGN_IN_LINK,
  [APPLICATION_RECEIVED.key]: APPLICATION_RECEIVED,
} as const;
