/**
 * The applicant form.
 *
 * What this is, precisely: the Phase 1 renderer for a form DEFINITION. It
 * proves that a program's form -- any program's form -- renders correctly from
 * data alone, with every field type, conditional reveals, live validation and a
 * review screen. It does NOT submit: the draft, autosave and submit endpoints
 * are Phase 2. Answers live in this browser's localStorage and nowhere else,
 * and the banner at the top says so, because a form that looks like it saved
 * and did not is the worst possible failure on a deadline.
 *
 * Everything about which fields are visible, what an answer coerces to and
 * which answers are missing comes from src/lib -- the same modules the Worker
 * runs. Nothing in this file re-implements a rule.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import type { FieldDef, StoredValue } from '../../src/lib/fieldTypes';
import { coerceAnswer } from '../../src/lib/fieldTypes';
import type { FormDefinition, SectionDef } from '../../src/lib/forms';
import { isFieldVisible, validateSubmission } from '../../src/lib/forms';
import { formatCents } from '../../src/lib/money';
import { Field } from './Field';

type Values = Record<string, unknown>;

/** localStorage key. Versioned so a schema change cannot resurrect stale shapes. */
function draftKey(formId: string): string {
  return `steward.draft.v1.${formId}`;
}

function loadDraft(formId: string): Values {
  try {
    const raw = window.localStorage.getItem(draftKey(formId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Values)
      : {};
  } catch {
    // A corrupt or unavailable store must not stop the form from opening.
    return {};
  }
}

interface Props {
  def: FormDefinition;
  onBack: () => void;
}

export function FormRenderer({ def, onBack }: Props): ReactElement {
  const [values, setValues] = useState<Values>(() => loadDraft(def.id));
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  // Which fields have been interacted with. An error is not shown on a field
  // nobody has touched yet -- a form that is red before you start is hostile.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  // Sections the applicant has tried to move past, plus review: those show all
  // of their errors whether or not the individual field was touched.
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [step, setStep] = useState(0);
  const reviewStep = def.sections.length;
  const onReview = step === reviewStep;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // ---- shared rules ---------------------------------------------------------

  const fields = useMemo(() => def.sections.flatMap((s) => s.fields), [def]);
  const fieldsById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);

  /** Coerce every answer once, exactly as the server does, then ask about visibility. */
  const visibility = useMemo(() => {
    const coerced = new Map<string, StoredValue>();
    for (const f of fields) {
      const r = coerceAnswer(f, values[f.field_key]);
      if (r.ok) coerced.set(f.id, r.stored);
    }
    const map = new Map<string, boolean>();
    for (const f of fields) map.set(f.id, isFieldVisible(f, coerced, fieldsById));
    return map;
  }, [fields, fieldsById, values]);

  const isVisible = useCallback((f: FieldDef) => visibility.get(f.id) !== false, [visibility]);

  /**
   * Whole-form validation, from the same function the submit endpoint calls.
   * Running it over the whole form on every keystroke is affordable at this
   * size (a few dozen fields) and means the review screen can never disagree
   * with the section the applicant is standing in.
   */
  const errorsByKey = useMemo(() => {
    const { errors } = validateSubmission(def, values);
    const map = new Map<string, string>();
    for (const e of errors) if (!map.has(e.field)) map.set(e.field, e.message);
    return map;
  }, [def, values]);

  const sectionErrorCount = useCallback(
    (section: SectionDef) =>
      section.fields.filter((f) => isVisible(f) && errorsByKey.has(f.field_key)).length,
    [errorsByKey, isVisible],
  );

  const sectionAnswered = useCallback(
    (section: SectionDef) => {
      const visibleFields = section.fields.filter(isVisible);
      if (visibleFields.length === 0) return false;
      return visibleFields.every((f) => {
        const r = coerceAnswer(f, values[f.field_key]);
        return r.ok && !r.empty;
      });
    },
    [isVisible, values],
  );

  const totalErrors = useMemo(
    () => def.sections.reduce((n, s) => n + sectionErrorCount(s), 0),
    [def.sections, sectionErrorCount],
  );

  /** The outstanding problems in the section currently on screen. */
  const currentErrors = useMemo(() => {
    const s = def.sections[step];
    if (!s) return [];
    return s.fields
      .filter((f) => isVisible(f) && errorsByKey.has(f.field_key))
      .map((f) => ({ fieldKey: f.field_key, message: errorsByKey.get(f.field_key)!, sectionIndex: step }));
  }, [def.sections, errorsByKey, isVisible, step]);

  // ---- persistence ----------------------------------------------------------

  // Autosave. Debounced so typing is not a write per keystroke, and flushed on
  // blur by the same effect because every blur changes `touched`.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey(def.id), JSON.stringify(values));
        setSavedAt(new Date());
        setSaveFailed(false);
      } catch {
        // Private browsing, a full quota, or storage disabled by policy. Say so
        // rather than showing a saved timestamp that is a lie.
        setSaveFailed(true);
      }
    }, 800);
    return () => window.clearTimeout(id);
  }, [values, def.id]);

  // Moving between steps moves focus to the new heading. Without this a
  // keyboard or screen-reader user presses Continue and lands nowhere.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // ---- interaction ----------------------------------------------------------

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const markTouched = useCallback((key: string) => {
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const errorFor = useCallback(
    (f: FieldDef, sectionIndex: number): string | null => {
      if (!touched.has(f.field_key) && !attempted.has(sectionIndex)) return null;
      return errorsByKey.get(f.field_key) ?? null;
    },
    [attempted, errorsByKey, touched],
  );

  const goTo = useCallback((next: number) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  /**
   * Continue.
   *
   * Validates the section BEFORE leaving it. Letting someone walk the whole
   * form and meet every problem at once on the review screen is how an
   * applicant loses half an hour on deadline day -- and the first version of
   * this function did exactly that: it marked the section attempted and moved
   * on in the same breath, so the errors it had just turned on were rendered
   * for a section that was no longer on screen. Caught in the browser, not by
   * reading the code.
   *
   * It blocks, but it does not trap: the section list on the left still jumps
   * anywhere, so an applicant who wants to come back to a hard question later
   * can.
   */
  const advance = useCallback(() => {
    setAttempted((prev) => new Set(prev).add(step));
    if (currentErrors.length > 0) {
      // Stay put and put focus on the list of problems.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    goTo(Math.min(step + 1, reviewStep));
  }, [currentErrors.length, goTo, reviewStep, step]);

  const clearDraft = useCallback(() => {
    if (!window.confirm('Clear every answer on this form? This cannot be undone.')) return;
    try {
      window.localStorage.removeItem(draftKey(def.id));
    } catch {
      /* nothing to clear */
    }
    setValues({});
    setTouched(new Set());
    setAttempted(new Set());
    goTo(0);
  }, [def.id, goTo]);

  const jumpToField = useCallback(
    (sectionIndex: number, fieldKey: string) => {
      goTo(sectionIndex);
      // After the section renders. rAF rather than a timeout so it lands on the
      // next paint rather than at an arbitrary delay.
      requestAnimationFrame(() => {
        const el = document.getElementById(`field-${fieldKey}`);
        const input = el?.querySelector<HTMLElement>('input, select, textarea');
        (input ?? el)?.focus?.();
        el?.scrollIntoView({ block: 'center', behavior: 'auto' });
      });
    },
    [goTo],
  );

  // ---- render ---------------------------------------------------------------

  const section = onReview ? null : def.sections[step];

  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to the form
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <h1>{def.name}</h1>
          <span className="program">
            Version {def.version} · {def.status}
          </span>
          <span className="spacer" />
          <button type="button" className="btn secondary" onClick={onBack}>
            Close preview
          </button>
        </div>
      </header>

      <div className="shell">
        <nav className="nav" aria-label="Form sections">
          <h2 id="sections-heading">Sections</h2>
          <ol aria-labelledby="sections-heading">
            {def.sections.map((s, i) => {
              const errs = attempted.has(i) || onReview ? sectionErrorCount(s) : 0;
              const done = errs === 0 && sectionAnswered(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={i === step ? 'step' : undefined}
                    onClick={() => goTo(i)}
                  >
                    <span
                      className="marker"
                      data-state={errs > 0 ? 'error' : done ? 'done' : undefined}
                      aria-hidden="true"
                    >
                      {errs > 0 ? '!' : i + 1}
                    </span>
                    <span>
                      {s.title}
                      {errs > 0 && (
                        <span className="sr-only">
                          {' '}
                          — {errs} question{errs === 1 ? '' : 's'} need attention
                        </span>
                      )}
                      {done && <span className="sr-only"> — complete</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                aria-current={onReview ? 'step' : undefined}
                onClick={() => {
                  setAttempted(new Set(def.sections.map((_, i) => i)));
                  goTo(reviewStep);
                }}
              >
                <span className="marker" aria-hidden="true">
                  {def.sections.length + 1}
                </span>
                <span>Review and submit</span>
              </button>
            </li>
          </ol>
        </nav>

        <main id="main" className="card">
          <p className="banner">
            <strong>Preview.</strong> This renders the form definition exactly as it is stored.
            Answers are kept in this browser only — nothing is sent to Steward and nothing is
            submitted. Draft saving, file uploads and submission are Phase 2.
          </p>

          {onReview ? (
            <ReviewStep
              def={def}
              values={values}
              errorsByKey={errorsByKey}
              isVisible={isVisible}
              headingRef={headingRef}
              summaryRef={summaryRef}
              totalErrors={totalErrors}
              onEditSection={(i) => goTo(i)}
              onJumpToField={jumpToField}
            />
          ) : (
            section && (
              <>
                <div className="section-head">
                  <span className="eyebrow">
                    Step {step + 1} of {def.sections.length + 1}
                  </span>
                  <h2 tabIndex={-1} ref={headingRef}>
                    {section.title}
                  </h2>
                  {section.description && <p>{section.description}</p>}
                </div>

                {attempted.has(step) && currentErrors.length > 0 && (
                  <ErrorSummary
                    items={currentErrors}
                    summaryRef={summaryRef}
                    onJump={jumpToField}
                  />
                )}

                <div className="fields">
                  {section.fields.filter(isVisible).map((f) => (
                    <Field
                      key={f.id}
                      field={f}
                      value={values[f.field_key]}
                      error={errorFor(f, step)}
                      onChange={(v) => setValue(f.field_key, v)}
                      onBlur={() => markTouched(f.field_key)}
                    />
                  ))}
                </div>
              </>
            )
          )}

          <div className="actions">
            {step > 0 && (
              <button type="button" className="btn secondary" onClick={() => goTo(step - 1)}>
                Back
              </button>
            )}
            {!onReview && (
              <button type="button" className="btn" onClick={advance}>
                {step === def.sections.length - 1 ? 'Review answers' : 'Continue'}
              </button>
            )}
            <span className="spacer" />
            <SaveState savedAt={savedAt} failed={saveFailed} />
            <button type="button" className="btn secondary" onClick={clearDraft}>
              Clear answers
            </button>
          </div>
        </main>
      </div>

      <footer className="privacy">
        <h2>What this form collects</h2>
        <p>
          This application asks for information about your organization, including its EIN,
          budget and financial statements, along with the contact details of the person
          submitting it. It is used to assess your request and to administer any resulting
          grant. It is not sold and is not shared outside the review process.
        </p>
        <p>
          Uploaded documents are stored privately and are reachable only through short-lived
          links issued to signed-in staff.
        </p>
      </footer>
    </div>
  );
}

interface SummaryItem {
  fieldKey: string;
  message: string;
  sectionIndex: number;
}

/**
 * The list of outstanding problems, in plain language, each one a link that
 * lands on the field it belongs to.
 *
 * Used both at the top of a section the applicant tried to leave and on the
 * review screen, so the two can never phrase the same problem differently. It
 * is focusable and gets focus when it appears -- an error message nobody is
 * moved to is an error message a keyboard user never hears.
 */
function ErrorSummary({
  items,
  summaryRef,
  onJump,
  heading,
}: {
  items: readonly SummaryItem[];
  summaryRef: RefObject<HTMLDivElement | null>;
  onJump: (sectionIndex: number, fieldKey: string) => void;
  heading?: string;
}): ReactElement {
  const n = items.length;
  return (
    <div className="summary" ref={summaryRef} tabIndex={-1} role="group" aria-labelledby="summary-heading">
      <h2 id="summary-heading">
        {heading ??
          `${n} question${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your attention before you continue`}
      </h2>
      <ol>
        {items.map((item) => (
          <li key={item.fieldKey}>
            <a
              href={`#field-${item.fieldKey}`}
              onClick={(e) => {
                e.preventDefault();
                onJump(item.sectionIndex, item.fieldKey);
              }}
            >
              {item.message}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The saved-state indicator.
 *
 * A polite live region: an applicant using a screen reader hears "Saved 2:14 PM"
 * without having it interrupt what they are typing.
 */
function SaveState({ savedAt, failed }: { savedAt: Date | null; failed: boolean }): ReactElement {
  return (
    <span className="counter" aria-live="polite">
      {failed
        ? 'Could not save in this browser'
        : savedAt
          ? `Saved in this browser at ${savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
          : 'Not saved yet'}
    </span>
  );
}

interface ReviewProps {
  def: FormDefinition;
  values: Values;
  errorsByKey: ReadonlyMap<string, string>;
  isVisible: (f: FieldDef) => boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  summaryRef: RefObject<HTMLDivElement | null>;
  totalErrors: number;
  onEditSection: (index: number) => void;
  onJumpToField: (sectionIndex: number, fieldKey: string) => void;
}

/**
 * Review before submit.
 *
 * Everything the applicant entered, read-only, with an edit link per section
 * and every outstanding problem listed at the top as a link that lands on the
 * offending field. This screen exists so nobody discovers a missing answer from
 * a rejection after they press submit.
 */
function ReviewStep({
  def,
  values,
  errorsByKey,
  isVisible,
  headingRef,
  summaryRef,
  totalErrors,
  onEditSection,
  onJumpToField,
}: ReviewProps): ReactElement {
  useEffect(() => {
    if (totalErrors > 0) summaryRef.current?.focus();
  }, [summaryRef, totalErrors]);

  return (
    <>
      <div className="section-head">
        <span className="eyebrow">
          Step {def.sections.length + 1} of {def.sections.length + 1}
        </span>
        <h2 tabIndex={-1} ref={headingRef}>
          Review your answers
        </h2>
        <p>
          Check everything below before submitting. Use the edit link beside a section to go
          back to it.
        </p>
      </div>

      {totalErrors > 0 && (
        <ErrorSummary
          summaryRef={summaryRef}
          onJump={onJumpToField}
          heading={`${totalErrors} question${totalErrors === 1 ? '' : 's'} still need${
            totalErrors === 1 ? 's' : ''
          } your attention`}
          items={def.sections.flatMap((s, i) =>
            s.fields
              .filter((f) => isVisible(f) && errorsByKey.has(f.field_key))
              .map((f) => ({
                fieldKey: f.field_key,
                message: errorsByKey.get(f.field_key)!,
                sectionIndex: i,
              })),
          )}
        />
      )}

      {def.sections.map((s, i) => {
        const shown = s.fields.filter(isVisible);
        return (
          <section key={s.id} className="review-section">
            <div className="review-head">
              <h3>{s.title}</h3>
              <button type="button" className="btn secondary" onClick={() => onEditSection(i)}>
                Edit<span className="sr-only"> {s.title}</span>
              </button>
            </div>
            <dl className="review-list">
              {shown.map((f) => (
                <div className="review-row" key={f.id}>
                  <dt>{f.label}</dt>
                  <dd data-empty={displayValue(f, values[f.field_key]) === null ? 'true' : undefined}>
                    {displayValue(f, values[f.field_key]) ?? 'Not answered'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}

      <p className="help">
        Submission is not available in this preview. In the live form this is where the
        application is validated in full on the server, written in one transaction, and
        confirmed by email with a read-only copy of everything above.
      </p>
    </>
  );
}

/**
 * Read-back formatting for the review screen.
 *
 * Returns null for "not answered" so the caller can style it as absent rather
 * than printing an empty row. Blank is the normal state on most fields.
 */
function displayValue(field: FieldDef, raw: unknown): string | null {
  const result = coerceAnswer(field, raw);
  if (!result.ok) return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  if (result.empty) {
    // An unchecked attestation is answered, not empty.
    if (field.field_type === 'checkbox_attestation' || field.field_type === 'consent_checkbox') {
      return 'No';
    }
    return null;
  }
  const s = result.stored;

  switch (field.field_type) {
    case 'checkbox_attestation':
    case 'consent_checkbox':
      return s.value_int === 1 ? 'Yes' : 'No';

    case 'currency':
      // Formatted once, here, at the display edge. Storage stays integer cents.
      return s.value_int === null ? null : formatCents(s.value_int);

    case 'integer':
      return s.value_int === null ? null : s.value_int.toLocaleString('en-US');

    case 'phone': {
      const d = s.value_text ?? '';
      return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || null;
    }

    case 'select': {
      const match = field.options.find((o) => o.value === s.value_text);
      return match?.label ?? s.value_text;
    }

    case 'multi_select': {
      const selected = safeJson<string[]>(s.value_json, []);
      if (selected.length === 0) return null;
      const labels = selected.map((v) => field.options.find((o) => o.value === v)?.label ?? v);
      return labels.join(', ');
    }

    case 'address_block': {
      const a = safeJson<Record<string, string>>(s.value_json, {});
      const lines = [a.address_1, a.address_2, [a.city, a.state].filter(Boolean).join(', '), a.postal_code]
        .filter((x) => x && x.trim() !== '')
        .join('\n');
      return lines === '' ? null : lines;
    }

    case 'file_upload': {
      const refs = safeJson<{ filename: string }[]>(s.value_json, []);
      return refs.length === 0 ? null : refs.map((r) => r.filename).join(', ');
    }

    default:
      return s.value_text;
  }
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
