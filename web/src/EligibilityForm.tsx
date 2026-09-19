/**
 * The eligibility screen — the page that never existed.
 *
 * It has been an API since Phase 2 with nothing in front of it, so the only
 * way a nonprofit reached it was an email from a program officer.
 *
 * WHY IT FAILS FAST, and why that is kindness rather than obstruction: this is
 * a short form that decides whether somebody should spend an evening on a long
 * one. CLAUDE.md is explicit -- never collect a full application from an
 * ineligible organization.
 *
 * WHAT HAPPENS AFTER SUBMIT IS DELIBERATELY UNINFORMATIVE, and that is not an
 * oversight. The server answers every outcome identically -- eligible,
 * already applied, address registered elsewhere, reports outstanding -- and
 * mails the reason to the address typed. Anything else would make a public
 * endpoint an oracle on other people's organizations. So this screen says "we
 * have sent you a link", because that is all it is entitled to know.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { FieldDef, StoredValue } from '../../src/lib/fieldTypes';
import { coerceAnswer } from '../../src/lib/fieldTypes';
import { allFields, isFieldVisible, validateSubmission } from '../../src/lib/forms';
import type { FormDefinition } from '../../src/lib/forms';
import { Field } from './Field';
import { Turnstile } from './Turnstile';
import { PrivacyNotice } from './OpenCycles';
import { publicApi, type OpenCycle } from './publicApi';
import { ApiError } from './http';

type Values = Record<string, unknown>;

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string }
  | { kind: 'sent'; message: string; email: string };

interface Props {
  cycle: OpenCycle;
  form: FormDefinition;
  turnstileSiteKey: string | null;
  onBack: () => void;
}

export function EligibilityForm({
  cycle,
  form,
  turnstileSiteKey,
  onBack,
}: Props): ReactElement {
  const [values, setValues] = useState<Values>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });

  const fields = useMemo(() => allFields(form), [form]);
  const fieldsById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);

  // The same coercion the Worker runs, so a form this page accepts is one the
  // server accepts. Nothing here re-implements a rule.
  const coerced = useMemo(() => {
    const out = new Map<string, StoredValue>();
    for (const f of fields) {
      const r = coerceAnswer(f, values[f.field_key]);
      if (r.ok) out.set(f.id, r.stored);
    }
    return out;
  }, [fields, values]);

  const isVisible = useCallback(
    (f: FieldDef) => isFieldVisible(f, coerced, fieldsById),
    [coerced, fieldsById],
  );

  const errors = useMemo(() => validateSubmission(form, values).errors, [form, values]);
  const errorsByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) if (!m.has(e.field)) m.set(e.field, e.message);
    return m;
  }, [errors]);

  const jumpToField = useCallback((key: string) => {
    const el = document.getElementById(`field-${key}`);
    const input = el?.querySelector<HTMLElement>('input, select, textarea');
    (input ?? el)?.focus?.();
    el?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, []);

  const submit = useCallback(async () => {
    setAttempted(true);
    if (errors.length > 0) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.summary')?.focus();
      });
      return;
    }
    setSend({ kind: 'sending' });
    try {
      const out = await publicApi.submitEligibility(cycle.id, values, token);
      setSend({ kind: 'sent', message: out.message, email: out.email });
    } catch (e) {
      setSend({
        kind: 'error',
        message:
          e instanceof ApiError
            ? e.message
            : 'We could not send that. Please check your connection and try again.',
      });
    }
  }, [cycle.id, errors.length, token, values]);

  if (send.kind === 'sent') {
    return (
      <div className="card portal-done">
        <h2 tabIndex={-1} data-route-heading>
          Check your email
        </h2>
        <p>{send.message}</p>
        <p className="portal-meta">
          We sent it to <strong>{send.email}</strong>. If it has not arrived in a few minutes,
          check the spam folder — and if it is not there either, the address may not be one we
          can start an application for. Either way, the email will explain.
        </p>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={onBack}>
            Back to open programs
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="section-head">
        <p className="eyebrow">{cycle.programName}</p>
        <h2 tabIndex={-1} data-route-heading>
          {cycle.firstStageName ?? 'Before you start'}
        </h2>
        <p>
          A few questions to check this program is a fit, before you spend time on the full
          application. {cycle.closesAtDisplay && <>Applications close {cycle.closesAtDisplay}.</>}
        </p>
      </div>

      <div className="card">
        {attempted && errors.length > 0 && (
          <div
            className="summary"
            tabIndex={-1}
            role="group"
            aria-labelledby="eligibility-summary-heading"
          >
            <h3 id="eligibility-summary-heading">
              {errors.length === 1
                ? 'One answer needs your attention'
                : `${errors.length} answers need your attention`}
            </h3>
            <ol>
              {errors.map((e) => (
                <li key={e.field}>
                  <a
                    href={`#field-${e.field}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      jumpToField(e.field);
                    }}
                  >
                    {e.message}
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

        {form.sections.map((section) => {
          const visible = section.fields.filter(isVisible);
          if (visible.length === 0) return null;
          return (
            <section key={section.id} className="portal-section">
              <div className="section-head">
                <h3>{section.title}</h3>
                {section.description && <p>{section.description}</p>}
              </div>
              <div className="fields">
                {visible.map((f) => (
                  <Field
                    key={f.id}
                    field={f}
                    value={values[f.field_key]}
                    // Not until they have left the field or tried to send. Red
                    // text under a box somebody is still typing in is a
                    // scolding, not help.
                    error={
                      attempted || touched.has(f.field_key)
                        ? (errorsByKey.get(f.field_key) ?? null)
                        : null
                    }
                    onChange={(v) => setValues((prev) => ({ ...prev, [f.field_key]: v }))}
                    onBlur={() => setTouched((prev) => new Set(prev).add(f.field_key))}
                  />
                ))}
              </div>
            </section>
          );
        })}

        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />

        <div className="actions">
          <button type="button" className="btn secondary" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="btn"
            onClick={submit}
            disabled={send.kind === 'sending'}
          >
            {send.kind === 'sending' ? 'Sending…' : 'Check and send me a link'}
          </button>
        </div>

        <p className="portal-meta">
          We will email you a sign-in link rather than asking you to make a password. Nothing
          is submitted at this point — the full application comes next, and you can save it and
          come back.
        </p>
      </div>

      <PrivacyNotice />
    </>
  );
}
