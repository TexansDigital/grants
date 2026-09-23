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
  | 'ambiguous_organization'
  /**
   * The program blocks a new application while a grant report is outstanding.
   *
   * It is here, and not an inline refusal, because the eligibility endpoint is
   * public and unauthenticated: answering "you have an overdue report" to
   * whoever typed the EIN turns it into an oracle on which nonprofits are
   * delinquent with the Foundation. The mailbox owner is entitled to know;
   * the caller may be anybody.
   */
  | 'reports_outstanding';

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
      reports_outstanding:
        'This program asks that reports on previous grants are filed before a new ' +
        'application is started, and our records show at least one still outstanding. ' +
        'You can see what is outstanding, and file it, by signing in to the grant ' +
        'reporting page with this address.',
    };
    const next: Record<SignInProblemReason, string> = {
      staff_account: 'Try again with an address belonging to the organization.',
      other_organization: 'Try again with an address for this organization.',
      ambiguous_organization: 'Reply to this email and we will sort it out and get you a link.',
      reports_outstanding:
        'File the outstanding report, then start your application again. If you believe ' +
        'it is already filed, reply to this email and we will check.',
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

export interface ReportReceivedVars {
  organizationName: string;
  programName: string;
  /** "Final report", "Year 2 report". The grantee's own words for it. */
  reportLabel: string;
  /** Formatted at the display edge by the caller. Cents never reach a template. */
  awardAmount: string;
  submittedAtDisplay: string;
  /** The full read-back, so they hold a record without signing back in. */
  answers: AnswerLine[];
}

/**
 * The receipt for a filed grant report.
 *
 * Same contract as the application confirmation and for the same reason: the
 * grantee gets a copy of everything they sent, in the email, without signing
 * back in. A nonprofit asked six months later "what did we tell them we
 * served" should be able to find it in their own inbox.
 *
 * DELIBERATELY NOT A DECISION. It says we have it and we will be in touch --
 * never that it is accepted. Acceptance is a staff act with its own record,
 * and a receipt that reads like approval is one somebody will quote back.
 */
export const REPORT_RECEIVED: EmailTemplate<ReportReceivedVars> = {
  key: 'report_received',
  render(v) {
    const facts: Array<[string, string]> = [
      ['Organization', v.organizationName],
      ['Program', v.programName],
      ['Grant', v.awardAmount],
      ['Report', v.reportLabel],
      ['Filed', v.submittedAtDisplay],
    ];

    const sections: Array<{ title: string; lines: AnswerLine[] }> = [];
    for (const line of v.answers) {
      const last = sections[sections.length - 1];
      if (last && last.title === line.section) last.lines.push(line);
      else sections.push({ title: line.section, lines: [line] });
    }

    const text = textBlock([
      `Thank you — we have your ${v.reportLabel.toLowerCase()}.`,
      '',
      ...facts.map(([k, val]) => `${k}: ${val}`),
      '',
      'A copy of everything you sent follows, so you have a record',
      'without signing back in.',
      '',
      ...sections.flatMap((sec) => [
        `--- ${sec.title} ---`,
        ...sec.lines.flatMap((l) => [`${l.label}:`, l.value === '' ? '(not answered)' : l.value, '']),
      ]),
      'Nothing else is needed from you on this report. If we have questions',
      'we will email this address.',
      'Replying to this message reaches a real person.',
    ]);

    const answersHtml = sections
      .map(
        (sec) => `
          <p style="margin:18px 0 8px 0;font-size:13px;font-weight:700;
                    text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};">${escapeHtml(sec.title)}</p>
          ${sec.lines
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
      subject: `We received your ${v.reportLabel.toLowerCase()}`,
      text,
      html: layout({
        preview: `Filed ${v.submittedAtDisplay}. A copy of your report is below.`,
        heading: 'Thank you — we have your report',
        blocks: [
          `Your ${escapeHtml(v.reportLabel.toLowerCase())} for the ${escapeHtml(v.programName)} grant is filed.`,
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
          `<span style="color:${INK_SOFT};">A copy of everything you sent is below, so you have a record without signing back in.</span>`,
          answersHtml,
        ],
        footer:
          'Nothing else is needed from you on this report. If we have questions we will ' +
          'email this address. Replying to this message reaches a real person.',
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
// ---------------------------------------------------------------------------
// files_due_for_deletion
// ---------------------------------------------------------------------------

export interface DueFileLine {
  organization: string;
  filename: string;
  dueDisplay: string;
}

export interface FilesDueForDeletionVars {
  fileCount: number;
  soonestDueDisplay: string;
  lines: DueFileLine[];
  /** How many files were left off the list, when there are many. */
  truncated: number;
  /** Into the app. Empty when no staff hostname is configured. */
  reviewUrl: string;
}

/**
 * "These applicants' financial documents are about to be destroyed."
 *
 * THE DOCUMENTS ARE NOT ATTACHED, and that is the point of the design rather
 * than an omission. Attaching them would multiply the copies the retention
 * policy exists to reduce -- outbox, two mailboxes, the mail provider, its
 * backups, every phone signed in, and anywhere the message is forwarded.
 * Steward can destroy its own copy. It cannot destroy those. So the notice
 * carries a link and the reader opens what they need inside the app, where the
 * read is scoped, five minutes long, and audited.
 *
 * WHAT THE NOTICE CAREFULLY DOES NOT CLAIM. A file drops off this list once a
 * download link has been ISSUED for it. Downloads go from the browser straight
 * to R2, so this system never learns whether the bytes arrived. The copy says
 * "asked for" rather than "downloaded", because the reader is deciding whether
 * it is safe to let somebody else's audited accounts be destroyed and should
 * not be told something the sender does not know.
 *
 * NO NAMES OF PEOPLE, no amounts, no narrative. An organization name and a
 * filename are enough to act on, and an email about financial documents should
 * not itself be a small copy of them.
 */
export const FILES_DUE_FOR_DELETION: EmailTemplate<FilesDueForDeletionVars> = {
  key: 'files_due_for_deletion',
  render(v) {
    const count = v.fileCount === 1 ? '1 file' : `${v.fileCount} files`;
    const lead =
      `${count} uploaded by applicants will be permanently deleted from Steward, ` +
      `the first on ${v.soonestDueDisplay}. None of them has been asked for yet.`;
    const rows = v.lines.map((l) => `  ${l.organization} — ${l.filename} (${l.dueDisplay})`);
    const more = v.truncated > 0 ? [`  …and ${v.truncated} more.`] : [];
    const action = v.reviewUrl
      ? 'Open Steward to read any of them, or to hold one longer:'
      : 'Open Steward to read any of them, or to hold one longer.';

    return {
      subject:
        v.fileCount === 1
          ? 'A file is due to be deleted from Steward'
          : `${v.fileCount} files are due to be deleted from Steward`,
      text: textBlock([
        lead,
        '',
        'These are financial documents belonging to the applicants, not to the',
        'Foundation. They are deleted on a schedule so that the Foundation is not',
        'holding other organizations\' audited accounts indefinitely.',
        '',
        ...rows,
        ...more,
        '',
        action,
        ...(v.reviewUrl ? ['', v.reviewUrl] : []),
        '',
        'Nothing is attached to this email on purpose. Opening a file inside',
        'Steward is recorded; a copy in a mailbox is not, and cannot be deleted',
        'by the policy this message is about.',
      ]),
      html: layout({
        preview: lead,
        heading: 'Files due to be deleted',
        blocks: [
          escapeHtml(lead),
          'These are financial documents belonging to the applicants, not to the Foundation. ' +
            'They are deleted on a schedule so that the Foundation is not holding other ' +
            'organizations&rsquo; audited accounts indefinitely.',
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
            v.lines
              .map(
                (l) =>
                  `<tr><td style="padding:4px 0;font-size:14px;line-height:1.5;">` +
                  `<strong>${escapeHtml(l.organization)}</strong><br>` +
                  `${escapeHtml(l.filename)} — deletes ${escapeHtml(l.dueDisplay)}</td></tr>`,
              )
              .join('') +
            (v.truncated > 0
              ? `<tr><td style="padding:4px 0;font-size:14px;">&hellip;and ${v.truncated} more.</td></tr>`
              : '') +
            `</table>`,
        ],
        ...(v.reviewUrl ? { action: { label: 'Open Steward', url: v.reviewUrl } } : {}),
        footer:
          'Nothing is attached to this email on purpose. Opening a file inside Steward is ' +
          'recorded; a copy in a mailbox is not, and cannot be deleted by the policy this ' +
          'message is about.',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// award_notification
// ---------------------------------------------------------------------------

export interface AwardNotificationVars {
  organizationName: string;
  projectTitle: string | null;
  programName: string;
  amountDisplay: string;
  /** When the grantee may talk about it. Null when there is no embargo. */
  announcementDisplay: string | null;
  portalUrl: string;
  supportEmail: string;
}

/**
 * "You have been awarded a grant."
 *
 * THE EMBARGO IS THE LOAD-BEARING PART. `announcement_date` is a separate fact
 * from `decided_at` for a reason CLAUDE.md states plainly: grantees told on
 * Tuesday post on Tuesday. A grant announcement that breaks a coordinated
 * launch is not the grantee being careless -- it is a letter that failed to
 * say when.
 *
 * So the embargo is not a footnote. It is its own block, before the link, in
 * both bodies, and worded as a request with a date rather than as legal
 * throat-clearing nobody reads.
 *
 * HUMAN RELEASE REQUIRED, like the decline. An award letter carries an amount,
 * and an amount sent to the wrong organization is not a correctable email.
 */
export const AWARD_NOTIFICATION: EmailTemplate<AwardNotificationVars> = {
  key: 'award_notification',
  requiresHumanRelease: true,
  render(v) {
    const what = v.projectTitle ? `${v.projectTitle}` : `your ${v.programName} application`;
    const embargoText = v.announcementDisplay
      ? [
          `Please hold this news until ${v.announcementDisplay}. We announce all`,
          `${v.programName} grants together on that date, and we will share materials`,
          'you can use beforehand.',
        ]
      : [];

    return {
      subject: `Your ${v.programName} grant application was successful`,
      text: textBlock([
        `${v.organizationName} has been awarded ${v.amountDisplay} for ${what}.`,
        '',
        'Congratulations. We were glad to read this application.',
        ...(embargoText.length > 0 ? ['', ...embargoText] : []),
        '',
        'Next: sign in to see the agreement, the reporting dates, and what we',
        'need from you before funds are released.',
        '',
        v.portalUrl,
        '',
        `Any questions, write to ${v.supportEmail}.`,
      ]),
      html: layout({
        preview: `${v.organizationName} has been awarded ${v.amountDisplay}.`,
        heading: 'Your grant application was successful',
        blocks: [
          `<strong>${escapeHtml(v.organizationName)}</strong> has been awarded ` +
            `<strong>${escapeHtml(v.amountDisplay)}</strong> for ${escapeHtml(what)}.`,
          'Congratulations. We were glad to read this application.',
          ...(v.announcementDisplay
            ? [
                `<strong>Please hold this news until ` +
                  `${escapeHtml(v.announcementDisplay)}.</strong> We announce all ` +
                  `${escapeHtml(v.programName)} grants together on that date, and we will ` +
                  `share materials you can use beforehand.`,
              ]
            : []),
          'Sign in to see the agreement, the reporting dates, and what we need from you ' +
            'before funds are released.',
        ],
        action: { label: 'Sign in', url: v.portalUrl },
        footer: `Any questions, write to ${escapeHtml(v.supportEmail)}.`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// decline_notification
// ---------------------------------------------------------------------------

export interface DeclineNotificationVars {
  organizationName: string;
  projectTitle: string | null;
  programName: string;
  /**
   * The letter itself, written by a person. Paragraphs, plain text.
   *
   * NOT a canned string with merge fields. This is the highest-reputation-risk
   * output in the system -- 250 of these go out in a week and one gets
   * screenshotted and forwarded -- and the Foundation has not settled its
   * wording. Inventing copy here and letting it ship would be this system
   * putting words in the Foundation's mouth to 250 nonprofits.
   *
   * So the template is a SHELL: the brand, the greeting, the footer, the
   * escaping. The words are supplied at send time by whoever is accountable
   * for them, and `requiresHumanRelease` means they cannot be sent without a
   * named person releasing them.
   */
  bodyParagraphs: string[];
  supportEmail: string;
  /** Shown only when the applicant can still reach their submission. */
  portalUrl: string | null;
}

/**
 * "We are not able to fund this."
 *
 * WHAT THIS TEMPLATE DOES NOT CONTAIN, deliberately: any reviewer score, any
 * criterion, any internal note, and the decision rationale recorded on the
 * application. Those are the Foundation's working papers. A decline that
 * quotes a score is an argument the applicant will want to have, and a decline
 * that quotes an internal note is a document nobody intended to publish.
 *
 * What it DOES carry is an invitation to reply, because a nonprofit that has
 * spent an hour on an application is owed a person rather than a no-reply
 * address.
 */
export const DECLINE_NOTIFICATION: EmailTemplate<DeclineNotificationVars> = {
  key: 'decline_notification',
  requiresHumanRelease: true,
  render(v) {
    const what = v.projectTitle ? `your application for ${v.projectTitle}` : 'your application';
    const paragraphs = v.bodyParagraphs.map((p) => p.trim()).filter(Boolean);

    return {
      // Not "Your application was unsuccessful" in the subject line. It lands
      // in a shared inbox and is read at a glance; the decision belongs in the
      // letter, where the words around it are the ones somebody chose.
      subject: `About your ${v.programName} application`,
      text: textBlock([
        `Thank you for ${what}.`,
        '',
        ...paragraphs.flatMap((p) => [p, '']),
        `If you would like to talk this through, write to ${v.supportEmail}.`,
        'A person reads that address.',
        ...(v.portalUrl ? ['', 'Your submission remains available here:', '', v.portalUrl] : []),
      ]),
      html: layout({
        preview: `About ${escapeHtml(v.organizationName)}'s ${escapeHtml(v.programName)} application`,
        heading: `About your ${v.programName} application`,
        blocks: [
          `Thank you for ${escapeHtml(what)}.`,
          ...paragraphs.map((p) => escapeHtml(p)),
        ],
        ...(v.portalUrl ? { action: { label: 'See your submission', url: v.portalUrl } } : {}),
        footer:
          `If you would like to talk this through, write to ${escapeHtml(v.supportEmail)}. ` +
          `A person reads that address.`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// report_reminder
// ---------------------------------------------------------------------------

export interface ReminderLine {
  /** "Final report", "Year 2 annual". */
  label: string;
  programName: string;
  dueDisplay: string;
  /** Negative means overdue. Used for wording, not shown as a number. */
  daysUntilDue: number;
}

export interface ReportReminderVars {
  organizationName: string;
  lines: ReminderLine[];
  /** The reporting page. A plain URL, never a token. */
  portalUrl: string;
  supportEmail: string;
}

/**
 * "Your grant report is due."
 *
 * THE LINK CARRIES NO TOKEN, and that is the whole security design of this
 * message rather than a detail. A reminder is a bulk send: it goes to a list,
 * it gets forwarded inside an organization, and it sits in mailboxes for
 * months. A sign-in token in it would be a credential with all of those
 * properties. So the letter points at the page, and the page mints a link when
 * the person asks for one -- which also means a reminder forwarded to a
 * colleague works correctly, because the colleague signs in as themselves.
 *
 * ONE LETTER PER GRANTEE, not one per report. An organization holding three
 * grants gets one message listing three reports. Three separate emails arriving
 * together is how a sender teaches a recipient to filter them, and the one that
 * matters is then filtered too.
 *
 * OVERDUE IS SAID PLAINLY AND WITHOUT THREAT. The Foundation's compliance
 * policy can refuse a new application over an unfiled report, so the letter
 * says that -- once, as a fact, at the end. What it does not do is imply the
 * grantee has done something wrong: the most common reason a report is late is
 * that nobody was ever told it was due, which is the gap this very message
 * exists to close.
 *
 * NO AMOUNTS, NO NARRATIVE, NO REPORT CONTENT. A reminder is an envelope. It
 * names the organization, the report and the date, and nothing a forwarded copy
 * should not carry.
 */
export const REPORT_REMINDER: EmailTemplate<ReportReminderVars> = {
  key: 'report_reminder',
  render(v) {
    const overdue = v.lines.filter((l) => l.daysUntilDue < 0);
    const soon = v.lines.filter((l) => l.daysUntilDue >= 0);
    const many = v.lines.length > 1;

    const subject = overdue.length > 0
      ? many
        ? `${v.lines.length} grant reports are outstanding`
        : 'Your grant report is overdue'
      : many
        ? `${v.lines.length} grant reports are due soon`
        : `Your ${v.lines[0]?.label.toLowerCase() ?? 'grant report'} is due ${v.lines[0]?.dueDisplay ?? 'soon'}`;

    const lead = overdue.length > 0
      ? `The Houston Texans Foundation is waiting on ${many ? 'reports' : 'a report'} from ` +
        `${v.organizationName}.`
      : `${v.organizationName} has ${many ? 'grant reports' : 'a grant report'} due.`;

    /** "Final report (Inspire Change) — due 31 March. Overdue." */
    const line = (l: ReminderLine): string => {
      const state =
        l.daysUntilDue < 0
          ? ' Overdue.'
          : l.daysUntilDue === 0
            ? ' Due today.'
            : l.daysUntilDue === 1
              ? ' Due tomorrow.'
              : ` Due in ${l.daysUntilDue} days.`;
      return `${l.label} (${l.programName}) — ${l.dueDisplay}.${state}`;
    };

    const howTo =
      'Open the reporting page and enter your email address. We will send you a ' +
      'link to sign in. There is no password, and this email does not contain one.';

    const consequence =
      overdue.length > 0
        ? 'An outstanding report can hold up a new application from your organization, ' +
          'so it is worth filing even if it is late.'
        : '';

    const askForHelp =
      `If a report is not yours to file, or the dates look wrong, reply to this message ` +
      `or write to ${v.supportEmail} and we will sort it out.`;

    return {
      subject,
      text: textBlock([
        lead,
        '',
        ...v.lines.map((l) => `  ${line(l)}`),
        '',
        howTo,
        '',
        v.portalUrl,
        ...(consequence ? ['', consequence] : []),
        '',
        askForHelp,
      ]),
      html: layout({
        preview: lead,
        heading: overdue.length > 0 ? 'A grant report is outstanding' : 'A grant report is due',
        blocks: [
          escapeHtml(lead),
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
            v.lines
              .map(
                (l) =>
                  `<tr><td style="padding:6px 0;font-size:15px;line-height:1.5;">` +
                  `<strong>${escapeHtml(l.label)}</strong> &middot; ${escapeHtml(l.programName)}<br>` +
                  `<span style="color:${INK_SOFT};">${escapeHtml(l.dueDisplay)}.` +
                  `${escapeHtml(
                    l.daysUntilDue < 0
                      ? ' Overdue.'
                      : l.daysUntilDue === 0
                        ? ' Due today.'
                        : l.daysUntilDue === 1
                          ? ' Due tomorrow.'
                          : ` Due in ${l.daysUntilDue} days.`,
                  )}</span></td></tr>`,
              )
              .join('') +
            `</table>`,
          escapeHtml(howTo),
          ...(consequence ? [escapeHtml(consequence)] : []),
        ],
        action: { label: 'Open the reporting page', url: v.portalUrl },
        footer: askForHelp,
      }),
    };
  },
};


export interface GranteeClaimReceivedVars {
  organizationName: string;
}

/**
 * "We have your details." Sent the moment a claim is filed.
 *
 * SAYS NOTHING ABOUT WHETHER A MATCH WAS FOUND, for the same reason the
 * endpoint does not: anyone can file a claim for any organization, and a
 * message reading "we found your 2024 grant" would confirm that organization
 * was funded to whoever typed its name. The acknowledgement is identical
 * either way.
 *
 * It also sets the expectation that a person is involved. A nonprofit who
 * fills in a form and hears nothing assumes it failed, and files it again.
 */
export const GRANTEE_CLAIM_RECEIVED: EmailTemplate<GranteeClaimReceivedVars> = {
  key: 'grantee_claim_received',
  render(v) {
    const heading = 'We have your details';
    const lines = [
      `Thank you for getting in touch about a grant to ${v.organizationName}.`,
      '',
      'Somebody at the Foundation will look at this and check our records. If we',
      'can match you to a grant, you will get a second email with a way to sign in',
      'and tell us what the funding made possible.',
      '',
      'There is nothing else you need to do for now, and you do not need to fill',
      'the form in again.',
    ];
    return {
      subject: 'We have your details — Houston Texans Foundation',
      text: textBlock(lines),
      html: layout({
        preview: 'A person at the Foundation will check our records and come back to you.',
        heading,
        blocks: [
          `<p style="margin:0;">Thank you for getting in touch about a grant to
           <strong>${escapeHtml(v.organizationName)}</strong>.</p>`,
          `<p style="margin:0;">Somebody at the Foundation will look at this and check our
           records. If we can match you to a grant, you will get a second email with a way to
           sign in and tell us what the funding made possible.</p>`,
          `<p style="margin:0;">There is nothing else you need to do for now, and you do not
           need to fill the form in again.</p>`,
        ],
        footer: 'Houston Texans Foundation',
      }),
    };
  },
};

export interface GranteeClaimApprovedVars {
  organizationName: string;
  /** The address they must sign in with. Theirs, echoed, because it decides. */
  email: string;
  signInUrl: string;
  /** What is waiting, in plain words. Empty when nothing is due yet. */
  whatIsDue: string | null;
}

/**
 * "You are connected. Here is how to sign in."
 *
 * NO MAGIC LINK IN THIS EMAIL, deliberately. Minting a login token from an
 * admin action means a credential for somebody else's account exists because a
 * staff member clicked a button, and it expires in fifteen minutes -- so an
 * approval done on a Friday afternoon is a dead link by the time anybody reads
 * it. Pointing at the sign-in page instead reuses the door that is already
 * behind Turnstile and rate limits, and works whenever they get round to it.
 *
 * The address is echoed because it is the thing that decides: somebody who
 * claimed with a personal address and signs in with a work one gets nothing,
 * and would have no way to know why.
 */
export const GRANTEE_CLAIM_APPROVED: EmailTemplate<GranteeClaimApprovedVars> = {
  key: 'grantee_claim_approved',
  render(v) {
    const heading = 'You can now tell us what your grant made possible';
    const due = v.whatIsDue ? [v.whatIsDue, ''] : [];
    return {
      subject: `${v.organizationName} — your grant reporting is open`,
      text: textBlock([
        `We have matched ${v.organizationName} to a grant in our records.`,
        '',
        ...due,
        'Sign in here:',
        v.signInUrl,
        '',
        `Use ${v.email} — that is the address your access is attached to. We will email`,
        'you a link; there is no password to remember.',
      ]),
      html: layout({
        preview: `Sign in with ${v.email} to file your update.`,
        heading,
        blocks: [
          `<p style="margin:0;">We have matched <strong>${escapeHtml(v.organizationName)}</strong>
           to a grant in our records.</p>`,
          ...(v.whatIsDue ? [`<p style="margin:0;">${escapeHtml(v.whatIsDue)}</p>`] : []),
          `<p style="margin:0;">Use <strong>${escapeHtml(v.email)}</strong> — that is the address
           your access is attached to. We will email you a link; there is no password to
           remember.</p>`,
        ],
        action: { label: 'Sign in', url: v.signInUrl },
        footer: 'Houston Texans Foundation',
      }),
    };
  },
};

/**
 * Every template this system can send.
 *
 * LAST IN THE FILE ON PURPOSE. The keys are computed from the template
 * constants, so the registry has to be evaluated after all of them -- a
 * `const` is not hoisted into an initializer, and a registry sitting halfway
 * up the file throws at module load the first time somebody appends a
 * template below it.
 *
 * A template missing from here is a template the sender cannot find, and
 * test/email.test.ts walks this object and demands a fixture for each, so
 * adding one without rendering it at least once is not possible.
 */
export const TEMPLATES = {
  [SIGN_IN_PROBLEM.key]: SIGN_IN_PROBLEM,
  [SIGN_IN_LINK.key]: SIGN_IN_LINK,
  [APPLICATION_RECEIVED.key]: APPLICATION_RECEIVED,
  [REPORT_RECEIVED.key]: REPORT_RECEIVED,
  [FILES_DUE_FOR_DELETION.key]: FILES_DUE_FOR_DELETION,
  [REPORT_REMINDER.key]: REPORT_REMINDER,
  [AWARD_NOTIFICATION.key]: AWARD_NOTIFICATION,
  [DECLINE_NOTIFICATION.key]: DECLINE_NOTIFICATION,
  [GRANTEE_CLAIM_RECEIVED.key]: GRANTEE_CLAIM_RECEIVED,
  [GRANTEE_CLAIM_APPROVED.key]: GRANTEE_CLAIM_APPROVED,
} as const;
