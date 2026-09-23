/**
 * "You funded us. Let us tell you what happened."
 *
 * WHO THIS IS FOR. A nonprofit the Foundation funded before this system
 * existed, who has no application here, no award row they can reach, and no
 * account. Everything else in the portal assumes one of those; this page
 * assumes none of them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never says whether the Foundation has
 * a matching grant. Not on submit, not before, not in a "we found you"
 * flourish. The server answers identically either way, because anything else
 * turns a public form into a way to ask "have you funded this organization"
 * for every EIN on every Form 990 -- and that is the Foundation's list to
 * publish, not a stranger's to enumerate.
 *
 * SHORT ON PURPOSE. Everything here is something a programme manager knows
 * without looking anything up. The EIN is optional because the person who
 * remembers what the grant paid for is often not the person who has the tax
 * paperwork, and refusing them at that point loses a claim a human could have
 * resolved in one email.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Turnstile } from './Turnstile';
import { PrivacyNotice } from './OpenCycles';
import { publicApi } from './publicApi';
import { ApiError } from './http';

interface Props {
  turnstileSiteKey: string | null;
  onBack: () => void;
}

type Send =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string }
  | { kind: 'sent'; message: string };

const THIS_YEAR = new Date().getFullYear();

export function GranteeClaim({ turnstileSiteKey, onBack }: Props): ReactElement {
  const [v, setV] = useState({
    organizationName: '',
    ein: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    jobTitle: '',
    grantYear: '',
    grantDescription: '',
  });
  const [token, setToken] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [send, setSend] = useState<Send>({ kind: 'idle' });
  const summaryRef = useRef<HTMLDivElement>(null);

  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  /*
   * The same three rules the server applies, and no more. A client check that
   * is stricter than the server's is a rule nobody wrote down, enforced on
   * the one person who cannot read the code.
   */
  const problems: { field: string; message: string }[] = [];
  if (v.organizationName.trim() === '') {
    problems.push({ field: 'organizationName', message: 'Tell us your organization’s name.' });
  }
  if (v.firstName.trim() === '' || v.lastName.trim() === '') {
    problems.push({ field: 'firstName', message: 'Tell us your name.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) {
    problems.push({ field: 'email', message: 'Check the email address.' });
  }

  /*
   * TAKE FOCUS TO THE REFUSAL.
   *
   * Drawing the summary is not telling anybody. A screen reader user who
   * presses submit and is left where they were has no signal that anything
   * happened at all -- the page silently grew a list above them. The
   * application form has always done this; this page did not, and a browser
   * drive is what noticed.
   *
   * Focus rather than a live region, and rather than both: the container
   * carries its own accessible name, so landing on it announces the count
   * once. role="alert" as well would read the whole list twice.
   */
  useEffect(() => {
    if (attempted && problems.length > 0) summaryRef.current?.focus();
    // Keyed on the count as well, so a second failed submit that fixed one
    // problem and left another still moves focus back to the list.
  }, [attempted, problems.length]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAttempted(true);
    if (problems.length > 0) return;
    setSend({ kind: 'sending' });
    try {
      const res = await publicApi.submitGranteeClaim(
        {
          organizationName: v.organizationName,
          ein: v.ein || null,
          firstName: v.firstName,
          lastName: v.lastName,
          email: v.email,
          phone: v.phone || null,
          jobTitle: v.jobTitle || null,
          grantYear: v.grantYear ? Number(v.grantYear) : null,
          grantDescription: v.grantDescription || null,
        },
        token,
      );
      setSend({ kind: 'sent', message: res.message });
    } catch (err) {
      setSend({
        kind: 'error',
        message:
          err instanceof ApiError
            ? err.message
            : 'That could not be sent. Please try again in a moment.',
      });
    }
  }

  if (send.kind === 'sent') {
    return (
      <>
        <div className="section-head">
          <h2 tabIndex={-1} data-route-heading>
            Thank you
          </h2>
        </div>
        <div className="card">
          <p>{send.message}</p>
          <p className="meta">
            You do not need to fill this in again. If you do not hear from us within a couple
            of weeks, reply to the confirmation email we have just sent.
          </p>
          <button type="button" className="btn secondary" onClick={onBack}>
            Back
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-head">
        <p className="eyebrow">Houston Texans Foundation</p>
        <h2 tabIndex={-1} data-route-heading>
          Tell us what your grant made possible
        </h2>
        <p>
          If the Foundation has funded your organization, we would like to hear what the
          money did — and to show some of it. Fill this in and somebody will check our
          records and come back to you with a way to sign in.
        </p>
      </div>

      <form className="card" onSubmit={(e) => void submit(e)} noValidate>
        {attempted && problems.length > 0 && (
          <div
            className="summary"
            ref={summaryRef}
            tabIndex={-1}
            role="group"
            aria-labelledby="claim-summary"
          >
            <h3 id="claim-summary">
              {problems.length === 1
                ? 'One answer needs your attention'
                : `${problems.length} answers need your attention`}
            </h3>
            <ol>
              {problems.map((p) => (
                <li key={p.field}>
                  <a
                    href={`#claim-${p.field}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      document.getElementById(`claim-${p.field}`)?.focus();
                    }}
                  >
                    {p.message}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}

        {send.kind === 'error' && (
          <p className="banner danger" role="alert">
            {send.message}
          </p>
        )}

        <section className="portal-section">
          <div className="section-head">
            <h3>Your organization</h3>
          </div>
          <div className="fields">
            <div className="stack">
              <label htmlFor="claim-organizationName">Organization name</label>
              <input
                id="claim-organizationName"
                value={v.organizationName}
                onChange={set('organizationName')}
                autoComplete="organization"
              />
            </div>
            <div className="stack">
              <label htmlFor="claim-ein">EIN</label>
              <p className="help" id="claim-ein-help">
                Optional. Nine digits, with or without the dash. It helps us find you faster,
                and we can manage without it.
              </p>
              <input
                id="claim-ein"
                value={v.ein}
                onChange={set('ein')}
                inputMode="numeric"
                aria-describedby="claim-ein-help"
              />
            </div>
          </div>
        </section>

        <section className="portal-section">
          <div className="section-head">
            <h3>You</h3>
          </div>
          <div className="fields">
            <div className="stack">
              <label htmlFor="claim-firstName">First name</label>
              <input id="claim-firstName" value={v.firstName} onChange={set('firstName')}
                     autoComplete="given-name" />
            </div>
            <div className="stack">
              <label htmlFor="claim-lastName">Last name</label>
              <input id="claim-lastName" value={v.lastName} onChange={set('lastName')}
                     autoComplete="family-name" />
            </div>
            <div className="stack">
              <label htmlFor="claim-email">Email address</label>
              <p className="help" id="claim-email-help">
                This is the address your access will be attached to, so use the one you
                want to sign in with.
              </p>
              <input id="claim-email" type="email" value={v.email} onChange={set('email')}
                     autoComplete="email" aria-describedby="claim-email-help" />
            </div>
            <div className="stack">
              <label htmlFor="claim-jobTitle">Job title</label>
              <input id="claim-jobTitle" value={v.jobTitle} onChange={set('jobTitle')}
                     autoComplete="organization-title" />
            </div>
            <div className="stack">
              <label htmlFor="claim-phone">Phone</label>
              <input id="claim-phone" type="tel" value={v.phone} onChange={set('phone')}
                     autoComplete="tel" />
            </div>
          </div>
        </section>

        <section className="portal-section">
          <div className="section-head">
            <h3>The grant</h3>
            <p>Roughly is fine. We will match it against our records.</p>
          </div>
          <div className="fields">
            <div className="stack">
              <label htmlFor="claim-grantYear">Around which year?</label>
              <input
                id="claim-grantYear"
                value={v.grantYear}
                onChange={set('grantYear')}
                inputMode="numeric"
                min={1990}
                max={THIS_YEAR}
              />
            </div>
            <div className="stack">
              <label htmlFor="claim-grantDescription">What was it for?</label>
              <textarea
                id="claim-grantDescription"
                rows={4}
                value={v.grantDescription}
                onChange={set('grantDescription')}
              />
            </div>
          </div>
        </section>

        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />

        <div className="portal-apply">
          <button type="button" className="btn secondary" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="btn" disabled={send.kind === 'sending'}>
            {send.kind === 'sending' ? 'Sending…' : 'Send this to the Foundation'}
          </button>
        </div>
      </form>

      <PrivacyNotice />
    </>
  );
}
