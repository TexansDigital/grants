/**
 * One application, as a staff member reads it.
 *
 * Two things sit side by side on purpose: the submission, and what this
 * organization has done before. CLAUDE.md is specific that the second is
 * institutional memory currently living in one person's head -- "they applied
 * three times, were funded once, filed both reports on time" -- and that a
 * reviewer should have it in front of them at the moment they are forming a
 * judgement, not have to go looking.
 *
 * Answers are rendered THROUGH the form definition, in the definition's order,
 * using the same coercion the Worker uses. A detail view that renders raw
 * answer rows drifts from the form the applicant actually filled in, and the
 * drift is invisible until someone reads a value under the wrong label.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { ApplicationDetail as Detail, OrganizationHistory, StoredAnswer } from './api';
import type { FieldDef } from '../../src/lib/fieldTypes';
import type { FormDefinition } from '../../src/lib/forms';
import { isFieldVisible } from '../../src/lib/forms';
import { formatCents } from '../../src/lib/money';
import type { StoredValue } from '../../src/lib/fieldTypes';

interface Props {
  applicationId: string;
  onBack: () => void;
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Render one stored answer for reading.
 *
 * Returns null for "not answered" so the caller can style absence rather than
 * printing an empty row. Blank is the normal state on most fields.
 */
function readAnswer(field: FieldDef, stored: StoredAnswer | undefined): string | null {
  if (!stored) return null;
  switch (field.field_type) {
    case 'currency':
      // Formatted once, at the display edge. Storage stays integer cents.
      return stored.value_int === null ? null : formatCents(stored.value_int);
    case 'integer':
      return stored.value_int === null ? null : stored.value_int.toLocaleString('en-US');
    case 'checkbox_attestation':
    case 'consent_checkbox':
      return stored.value_int === null ? null : stored.value_int === 1 ? 'Yes' : 'No';
    case 'phone': {
      const d = stored.value_text ?? '';
      return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d || null;
    }
    case 'select': {
      const match = field.options.find((o) => o.value === stored.value_text);
      return match?.label ?? stored.value_text;
    }
    case 'multi_select': {
      const values = safeJson<string[]>(stored.value_json, []);
      if (values.length === 0) return null;
      return values.map((v) => field.options.find((o) => o.value === v)?.label ?? v).join(', ');
    }
    case 'address_block': {
      const a = safeJson<Record<string, string>>(stored.value_json, {});
      const lines = [a.address_1, a.address_2, [a.city, a.state].filter(Boolean).join(', '), a.postal_code]
        .filter((x) => x && x.trim() !== '')
        .join('\n');
      return lines === '' ? null : lines;
    }
    case 'file_upload': {
      const refs = safeJson<{ filename: string }[]>(stored.value_json, []);
      return refs.length === 0 ? null : refs.map((r) => r.filename).join(', ');
    }
    default:
      return stored.value_text;
  }
}

export function ApplicationDetail({ applicationId, onBack }: Props): ReactElement {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<FormDefinition | null>(null);
  const [history, setHistory] = useState<OrganizationHistory | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setForm(null);
    setHistory(null);

    (async () => {
      try {
        const d = await api.application(applicationId, controller.signal);
        setDetail(d);

        // The definition and the history are secondary: a failure in either
        // must not blank the application itself. A reviewer with the answers
        // and no history panel can still do their job.
        const formId = (d.application as unknown as { form_definition_id?: string }).form_definition_id;
        if (formId) {
          api
            .form(formId, controller.signal)
            .then((r) => setForm(r.form))
            .catch(() => setForm(null));
        }
        api
          .history(d.application.organization_id, controller.signal)
          .then(setHistory)
          .catch(() => setHistory(null));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [applicationId]);

  if (loading) return <p className="meta">Loading…</p>;

  if (error) {
    return (
      <section className="panel">
        <h2>{error.status === 404 ? 'Not found' : 'Something went wrong'}</h2>
        <p className="meta">
          {error.status === 404
            ? 'This application does not exist, or it is not assigned to you.'
            : error.message}
        </p>
        <button type="button" className="btn small secondary" onClick={onBack}>
          Back to pipeline
        </button>
      </section>
    );
  }

  if (!detail) return <p className="meta">Nothing to show.</p>;

  const app = detail.application;
  const org = (detail.organization ?? {}) as Record<string, unknown>;

  // Visibility is judged with the SAME function the Worker uses, so a
  // conditional field the applicant never saw is not shown here as blank --
  // which would read as an unanswered question rather than an absent one.
  const fieldsById = new Map<string, FieldDef>();
  const coerced = new Map<string, StoredValue>();
  if (form) {
    for (const section of form.sections) {
      for (const field of section.fields) {
        fieldsById.set(field.id, field);
        const stored = detail.answers[field.field_key];
        if (stored) {
          coerced.set(field.id, {
            value_text: stored.value_text,
            value_int: stored.value_int,
            value_real: stored.value_real,
            value_json: stored.value_json,
          });
        }
      }
    }
  }

  return (
    <>
      <div className="crumbs">
        <button type="button" className="linklike" onClick={onBack}>
          Pipeline
        </button>
        <span aria-hidden="true">/</span>
        <span>{String(org.legal_name ?? 'Application')}</span>
      </div>

      <div className="detail">
        <div className="detail-main">
          <section className="panel">
            <div className="panel-head">
              <h2 tabIndex={-1} data-route-heading>
                {app.project_title ?? 'Untitled request'}
              </h2>
              <span className={`badge badge-${app.status}`}>{app.status.replace(/_/g, ' ')}</span>
              {app.requested_amount_cents !== null && (
                <span className="meta strong">{formatCents(app.requested_amount_cents)} requested</span>
              )}
            </div>

            <dl className="facts">
              <div>
                <dt>Organization</dt>
                <dd>{String(org.legal_name ?? '—')}</dd>
              </div>
              <div>
                <dt>EIN</dt>
                <dd>
                  {org.ein ? String(org.ein).replace(/^(\d{2})(\d{7})$/, '$1-$2') : '—'}
                  {org.ein_verified_at ? (
                    <span className="badge badge-published">verified</span>
                  ) : (
                    <span className="badge badge-draft">unverified</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Cycle</dt>
                <dd>{app.cycle_name ?? '—'}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{app.submitted_at ? app.submitted_at.slice(0, 10) : 'Not submitted'}</dd>
              </div>
            </dl>
          </section>

          {/* ---- the submission --------------------------------------------- */}
          {form ? (
            form.sections.map((section) => {
              const visible = section.fields.filter((f) => isFieldVisible(f, coerced, fieldsById));
              if (visible.length === 0) return null;
              return (
                <section className="panel" key={section.id}>
                  <h3>{section.title}</h3>
                  <dl className="answers">
                    {visible.map((field) => {
                      const value = readAnswer(field, detail.answers[field.field_key]);
                      return (
                        <div key={field.id}>
                          {/* The label AS ASKED, falling back to the current
                              definition only when an answer is absent. A
                              reviewer must read the question the applicant
                              saw, not the one it has since become. */}
                          <dt>{detail.answers[field.field_key]?.label_at_answer ?? field.label}</dt>
                          <dd data-empty={value === null ? 'true' : undefined}>
                            {value ?? 'Not answered'}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              );
            })
          ) : (
            <section className="panel">
              <p className="meta">
                The form definition could not be loaded, so answers cannot be shown under their
                labels. Reload to try again.
              </p>
            </section>
          )}

          {detail.attachments.length > 0 && (
            <section className="panel">
              <h3>Attachments</h3>
              <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Size
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.attachments.map((a) => (
                    <tr key={a.id}>
                      <th scope="row">{a.filename}</th>
                      <td>{a.mime_type}</td>
                      <td className="num">{Math.ceil(a.size_bytes / 1024).toLocaleString('en-US')} KB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="meta">
                Downloads are not available yet. Files will be served through short-lived signed
                links that are audited when issued.
              </p>
            </section>
          )}
        </div>

        {/* ---- applicant history ------------------------------------------- */}
        <aside className="detail-side">
          <section className="panel">
            <h3>This organization</h3>
            {history === null ? (
              <p className="meta">History unavailable.</p>
            ) : (
              <>
                <p className="bignum">
                  {history.summary.total_applications}
                  <span>application{history.summary.total_applications === 1 ? '' : 's'}</span>
                </p>
                <ul className="tally">
                  {Object.entries(history.summary.by_status).map(([status, n]) => (
                    <li key={status}>
                      <span className={`badge badge-${status}`}>{status.replace(/_/g, ' ')}</span>
                      <span className="num">{n}</span>
                    </li>
                  ))}
                </ul>
                <ol className="timeline">
                  {history.applications.map((h) => (
                    <li key={h.id} data-current={h.id === applicationId ? 'true' : undefined}>
                      <span className="when">{h.submitted_at ? h.submitted_at.slice(0, 7) : '—'}</span>
                      <span className="what">
                        {h.project_title ?? 'Untitled'}
                        {h.requested_amount_cents !== null && (
                          <span className="meta"> · {formatCents(h.requested_amount_cents)}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
                {/* Award history is deliberately absent rather than guessed at
                    from a status name. The awards table arrives in 0007. */}
                <p className="meta">
                  Award and reporting history appears here once the awards module exists.
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
