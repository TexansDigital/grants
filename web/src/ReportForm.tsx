/**
 * Filing one grant report.
 *
 * NOT the applicant form with different words. A report is short and is filed
 * from a phone in one sitting, so this is one scrolling page with one button at
 * the bottom -- no step wizard, no separate review screen. CLAUDE.md puts the
 * bar at three clicks from the portal to a filed report: open, fill, send.
 *
 * Everything that decides WHAT is asked, whether an answer is valid and which
 * fields are visible comes from src/lib -- the same modules the Worker runs on
 * submit. Nothing here re-implements a rule, so the page cannot accept
 * something the server will refuse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { FieldDef, StoredValue } from '../../src/lib/fieldTypes';
import { coerceAnswer } from '../../src/lib/fieldTypes';
import { allFields, isFieldVisible, validateSubmission } from '../../src/lib/forms';
import { formatCents } from '../../src/lib/money';
import { Field } from './Field';
import { ServerSaveState } from './SaveState';
import { useDraftSync } from './useDraftSync';
import { reportDraftPathFor, reportUploadPathFor } from './applicantApi';
import { granteeApi, type ReportResponse } from './granteeApi';
import { ApiError } from './http';
import { formatDay } from './reportWording';

type Values = Record<string, unknown>;

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string }
  | { kind: 'sent'; metricsRecorded: number };

interface Props {
  data: ReportResponse;
  onBack: () => void;
}

export function ReportForm({ data, onBack }: Props): ReactElement {
  const { report, award, form } = data;
  const [values, setValues] = useState<Values>(() => data.answers);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Destructured, never held as one object: change and flush are stable per
  // sync instance and go in dependency arrays; state is not.
  const { state: draftState, change, flush } = useDraftSync(
    report.canFile ? reportDraftPathFor(report.id) : null,
  );

  useEffect(() => {
    if (report.canFile) change(values);
  }, [change, values, report.canFile]);

  const fields = useMemo(() => (form ? allFields(form) : []), [form]);
  const fieldsById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);

  /** Coerced answers, for the visibility rules. Exactly what the server does. */
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

  const errors = useMemo(
    () => (form ? validateSubmission(form, values).errors : []),
    [form, values],
  );
  const errorsByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) if (!m.has(e.field)) m.set(e.field, e.message);
    return m;
  }, [errors]);

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  /**
   * Field.tsx already gives every field an id of `field-<key>`, which is the
   * anchor the applicant form's error list uses. Same mechanism here, so a
   * keyboard user lands INSIDE the control rather than next to it -- focusing
   * the wrapper means the error message they were sent to is never read out.
   */
  const jumpToField = useCallback((key: string) => {
    const el = document.getElementById(`field-${key}`);
    const input = el?.querySelector<HTMLElement>('input, select, textarea');
    (input ?? el)?.focus?.();
    el?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, []);

  const fileIt = useCallback(async () => {
    setAttempted(true);
    if (errors.length > 0) {
      // Focus the list rather than the first bad field: somebody who skipped
      // three questions needs to see that there are three.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setSend({ kind: 'sending' });
    try {
      // Land the autosave first, so what is filed and what was drafted cannot
      // disagree if the request that follows fails halfway.
      await flush();
      const out = await granteeApi.file(report.id, values);
      setSend({ kind: 'sent', metricsRecorded: out.metricsRecorded });
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.message
          : 'We could not send this report. Your answers are saved — please try again.';
      setSend({ kind: 'error', message });
      requestAnimationFrame(() => summaryRef.current?.focus());
    }
  }, [errors.length, flush, report.id, values]);

  if (send.kind === 'sent') {
    return (
      <div className="card portal-done">
        <h2 tabIndex={-1} data-route-heading>
          Thank you — that is filed
        </h2>
        <p>
          We have your {report.label.toLowerCase()} for the {award.program} grant. Nothing else
          is needed from you on this one.
        </p>
        <p className="portal-meta">
          If we have questions we will email the address you signed in with.
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={onBack}>
            Back to your grants
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="section-head">
        <p className="eyebrow">
          {award.program}
          {award.amountCents !== null && <> · {formatCents(award.amountCents)}</>}
        </p>
        <h2 tabIndex={-1} ref={headingRef} data-route-heading>
          {report.label}
        </h2>
        <p>
          {report.periodStart && report.periodEnd ? (
            <>
              Covering {formatDay(report.periodStart)} to {formatDay(report.periodEnd)}. Due{' '}
              {formatDay(report.dueDate)}.
            </>
          ) : (
            <>Due {formatDay(report.dueDate)}.</>
          )}
        </p>
      </div>

      {report.feedback && (
        <div className="banner" role="note">
          <strong>What we asked you to change:</strong> {report.feedback}
        </div>
      )}

      {!report.canFile || !form ? (
        <div className="card portal-empty">
          <h3>{closedHeading(report.state)}</h3>
          <p>{closedExplanation(report.state)}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={onBack}>
              Back to your grants
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          {draftState.status === 'signed_out' && (
            <p className="banner danger" role="alert">
              <strong>Your sign-in has expired.</strong> Everything up to the last save is safe.
              Open the link in your email again to carry on.
            </p>
          )}

          {attempted && errors.length > 0 && (
            <div
              className="summary"
              ref={summaryRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="report-summary-heading"
            >
              <h3 id="report-summary-heading">
                {errors.length === 1
                  ? 'One question still needs an answer'
                  : `${errors.length} questions still need an answer`}
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
            <div className="banner danger" role="alert" tabIndex={-1} ref={summaryRef}>
              {send.message}
            </div>
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
                      // An error only after somebody has left the field or
                      // tried to send: red text under a box they have not
                      // finished typing in is a scolding, not help.
                      error={
                        attempted || touched.has(f.field_key)
                          ? (errorsByKey.get(f.field_key) ?? null)
                          : null
                      }
                      onChange={(v) => setValue(f.field_key, v)}
                      onBlur={() =>
                        setTouched((prev) => new Set(prev).add(f.field_key))
                      }
                      uploadPath={reportUploadPathFor(report.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          <div className="actions">
            <button type="button" className="btn secondary" onClick={onBack}>
              Back
            </button>
            <button
              type="button"
              className="btn"
              onClick={fileIt}
              disabled={send.kind === 'sending'}
            >
              {send.kind === 'sending' ? 'Sending…' : 'Send this report'}
            </button>
            <span className="spacer" />
            <ServerSaveState state={draftState} />
          </div>
        </div>
      )}
    </>
  );
}

function closedHeading(state: ReportResponse['report']['state']): string {
  switch (state) {
    case 'submitted':
      return 'This one is already sent';
    case 'accepted':
      return 'This one is accepted';
    case 'waived':
      return 'We are not asking for this one';
    case 'not_open_yet':
      return 'This one is not open yet';
    default:
      return 'Nothing to fill in yet';
  }
}

function closedExplanation(state: ReportResponse['report']['state']): string {
  switch (state) {
    case 'submitted':
      return 'We have it. If we need anything else we will email you.';
    case 'accepted':
      return 'Nothing more is needed from you on this report.';
    case 'waived':
      return 'Staff decided this report is not required.';
    case 'not_open_yet':
      return 'We will email you when it opens, in good time before it is due.';
    default:
      return 'We are still preparing the questions for this report. Nothing to do yet.';
  }
}
