/**
 * Building a scoring rubric, by hand, in the app.
 *
 * WHY A BUILDER RATHER THAN AN UPLOAD. The first idea was to upload a scoring
 * template and have a model turn it into a screen. That works once and is
 * unaccountable afterwards: nobody can say what the weights were in the cycle
 * that has already been decided, a re-upload silently rewrites a rubric
 * applications were scored against, and a merged cell produces criteria nobody
 * intended. Here a person types the criteria, sees the total resolve as they
 * go, and publishes deliberately -- and publishing freezes it.
 *
 * THE WEIGHT FIELD TAKES A DECIMAL AND STORES BASIS POINTS. Nobody thinks in
 * basis points; everybody thinks "this one counts double". So the input reads
 * 2 and the wire carries 20000. The conversion happens once, here, at the edge
 * -- the same rule money follows.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { RubricDetail, RubricRow } from './api';

const WEIGHT_ONE_BP = 10000;

interface Props {
  programId: string;
  programName: string;
}

interface DraftCriterion {
  criterionKey: string;
  label: string;
  description: string;
  /** What the person typed, e.g. "1.5". Converted on save, not on keystroke. */
  weight: string;
  maxScore: string;
}

/** A label becomes a key, so nobody has to invent one. Editable afterwards. */
function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function toBasisPoints(weight: string): number {
  // Round to the nearest basis point rather than truncating: 0.15 in binary
  // floating point is 0.1499999..., and truncating turns a weight somebody
  // typed into one basis point less than they meant.
  return Math.round(Number(weight) * WEIGHT_ONE_BP);
}

/** Score-basis-points to points, for display only. */
function formatTotal(bp: number): string {
  return (bp / WEIGHT_ONE_BP).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function RubricBuilder({ programId, programName }: Props): ReactElement {
  const [rubrics, setRubrics] = useState<RubricRow[] | null>(null);
  const [open, setOpen] = useState<RubricDetail | null>(null);
  const [rows, setRows] = useState<DraftCriterion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await api.rubrics(programId, signal);
        setRubrics(r.rubrics);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [programId],
  );

  useEffect(() => {
    const c = new AbortController();
    void loadList(c.signal);
    return () => c.abort();
  }, [loadList]);

  /*
   * Re-read one rubric from the server.
   *
   * DOES NOT CLEAR THE NOTICE, though it clears the errors. Save and publish
   * both set a message and then call this to pick up what the server actually
   * stored -- so clearing here wiped "Saved. This rubric is scored out of 55"
   * a few milliseconds after it appeared, and the screen confirmed nothing.
   * The browser harness caught it; nothing in the unit tests could.
   *
   * Callers that want a clean slate clear the notice themselves first.
   */
  async function openRubric(id: string): Promise<void> {
    setError(null);
    setFieldErrors([]);
    try {
      const detail = await api.rubric(id);
      setOpen(detail);
      setRows(
        detail.criteria.map((c) => ({
          criterionKey: c.criterion_key,
          label: c.label,
          description: c.description ?? '',
          weight: String(c.weight_bp / WEIGHT_ONE_BP),
          maxScore: String(c.max_score),
        })),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function create(): Promise<void> {
    const name = window.prompt(`Name this rubric, for ${programName}:`);
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createRubric(programId, name, keyFromLabel(name));
      setNotice(null);
      await loadList();
      await openRubric(created.rubricId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function update(i: number, patch: Partial<DraftCriterion>): void {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function move(i: number, by: number): void {
    setRows((prev) => {
      const j = i + by;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!open) return;
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    setNotice(null);
    try {
      const result = await api.saveRubricCriteria(
        open.rubric.id,
        rows.map((r) => ({
          criterionKey: r.criterionKey.trim() || keyFromLabel(r.label),
          label: r.label,
          description: r.description || null,
          weightBp: toBasisPoints(r.weight),
          maxScore: Number(r.maxScore),
        })),
      );
      setNotice(`Saved. This rubric is scored out of ${formatTotal(result.maxTotalScoreBp)}.`);
      await openRubric(open.rubric.id);
      await loadList();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? []);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (!open) return;
    // Publishing freezes it. Saying so before, not after, because the way back
    // is a new version rather than an undo.
    if (
      !window.confirm(
        'Publishing freezes this rubric. Criteria and weights cannot be changed ' +
          'afterwards — only copied into a new version. Publish it?',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.publishRubric(open.rubric.id);
      setNotice(
        `Published version ${r.version}, scored out of ${formatTotal(r.maxTotalScoreBp)}.`,
      );
      await openRubric(open.rubric.id);
      await loadList();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? []);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function newVersion(): Promise<void> {
    if (!open) return;
    setBusy(true);
    try {
      const created = await api.newRubricVersion(open.rubric.id);
      await loadList();
      await openRubric(created.rubricId);
      setNotice(`Version ${created.version} is a draft. Change it, then publish.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const isDraft = open?.rubric.status === 'draft';
  const liveTotal = rows.reduce(
    (t, r) => t + (Number(r.maxScore) || 0) * (toBasisPoints(r.weight) || 0),
    0,
  );

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>
            Scoring rubrics
          </h2>
          <button type="button" className="btn" onClick={() => void create()} disabled={busy}>
            New rubric
          </button>
        </div>
        <p className="meta">
          A rubric is the instrument a funding decision is made with. Publishing freezes it, so
          what a closed cycle was scored against stays answerable. To change a published rubric,
          copy it into a new version.
        </p>

        {error && (
          <p className="banner danger" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="banner" role="status">
            {notice}
          </p>
        )}

        {rubrics === null ? (
          <p className="meta" aria-live="polite">
            Loading…
          </p>
        ) : rubrics.length === 0 ? (
          <p className="meta">No rubrics yet for {programName}.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Rubric</th>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Out of
                  </th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rubrics.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.name}</th>
                    <td>{r.version}</td>
                    <td>{r.status}</td>
                    <td className="num">
                      {r.max_total_score === null ? '—' : formatTotal(r.max_total_score)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => void openRubric(r.id)}
                      >
                        Open<span className="sr-only"> {r.name} version {r.version}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && (
        <section className="panel">
          <div className="panel-head">
            <h3>
              {open.rubric.name} — version {open.rubric.version} ({open.rubric.status})
            </h3>
            {isDraft ? (
              <button type="button" className="btn" onClick={() => void publish()} disabled={busy}>
                Publish
              </button>
            ) : (
              <button
                type="button"
                className="btn secondary"
                onClick={() => void newVersion()}
                disabled={busy}
              >
                New version from this
              </button>
            )}
          </div>

          {!isDraft && (
            <p className="meta">
              This version is frozen. {open.cyclesUsing.length > 0
                ? `Used by ${open.cyclesUsing.map((c) => c.name).join(', ')}.`
                : 'No cycle uses it yet.'}
            </p>
          )}

          {fieldErrors.length > 0 && (
            <ul className="banner danger" role="alert">
              {fieldErrors.map((f) => (
                <li key={f.field}>{f.message}</li>
              ))}
            </ul>
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col" className="num">
                    Out of
                  </th>
                  <th scope="col" className="num">
                    Weight
                  </th>
                  <th scope="col" className="num">
                    Counts for
                  </th>
                  {isDraft && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${i}-${r.criterionKey}`}>
                    <td>
                      <label className="stack">
                        <span className="sr-only">Label for criterion {i + 1}</span>
                        <input
                          id={`crit-label-${i}`}
                          type="text"
                          value={r.label}
                          disabled={!isDraft}
                          onChange={(e) => {
                            const label = e.target.value;
                            // The key follows the label only while the row is
                            // new. Once a criterion has been saved its key is
                            // what carries scores across versions, and
                            // renaming the label must not move it.
                            update(i, {
                              label,
                              ...(r.criterionKey ? {} : { criterionKey: keyFromLabel(label) }),
                            });
                          }}
                        />
                      </label>
                      <label className="stack">
                        <span className="sr-only">Guidance for criterion {i + 1}</span>
                        <textarea
                          id={`crit-desc-${i}`}
                          rows={2}
                          placeholder="What a reviewer should look for"
                          value={r.description}
                          disabled={!isDraft}
                          onChange={(e) => update(i, { description: e.target.value })}
                        />
                      </label>
                      <span className="meta">{r.criterionKey}</span>
                    </td>
                    <td className="num">
                      <input
                        id={`crit-max-${i}`}
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={r.maxScore}
                        disabled={!isDraft}
                        onChange={(e) => update(i, { maxScore: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        id={`crit-weight-${i}`}
                        type="number"
                        min={0}
                        step="0.05"
                        value={r.weight}
                        disabled={!isDraft}
                        onChange={(e) => update(i, { weight: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      {formatTotal((Number(r.maxScore) || 0) * (toBasisPoints(r.weight) || 0))}
                    </td>
                    {isDraft && (
                      <td className="actions">
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                        >
                          Up<span className="sr-only"> — move {r.label || `criterion ${i + 1}`} earlier</span>
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => move(i, 1)}
                          disabled={i === rows.length - 1}
                        >
                          Down<span className="sr-only"> — move {r.label || `criterion ${i + 1}`} later</span>
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Remove<span className="sr-only"> {r.label || `criterion ${i + 1}`}</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>
                    Scored out of
                  </th>
                  <td className="num">
                    <strong>{formatTotal(liveTotal)}</strong>
                  </td>
                  {isDraft && <td />}
                </tr>
              </tfoot>
            </table>
          </div>

          {isDraft && (
            <div className="actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    { criterionKey: '', label: '', description: '', weight: '1', maxScore: '10' },
                  ])
                }
              >
                Add criterion
              </button>
              <button type="button" className="btn" onClick={() => void save()} disabled={busy}>
                Save draft
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
