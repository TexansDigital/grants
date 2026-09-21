/**
 * Sending a consultant a scorecard, and reading it back.
 *
 * THE FALLBACK, NOT THE PATH, and the screen says so. CLAUDE.md is explicit
 * that uploaded scorecards drift from the rubric, carry no conflict
 * declaration, and produce no audit trail, and that this exists so a
 * consultant does not block a decision rather than as the normal way to score.
 * Two of those three are fixed by the import; the third cannot be, and an
 * admin choosing this route should be told which is which.
 *
 * PREVIEW BEFORE APPLY, like the awards importer. A file somebody edited in
 * Excel over a weekend is not a thing to apply unseen, and the preview is
 * where a rubric-version mismatch is caught -- the failure that would
 * otherwise land scores against the wrong criteria invisibly.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { ScorecardPlan, CycleReviewer } from './api';

interface Props {
  cycleId: string;
  onBack: () => void;
}

export function Scorecards({ cycleId, onBack }: Props): ReactElement {
  const [reviewers, setReviewers] = useState<CycleReviewer[] | null>(null);
  const [csv, setCsv] = useState('');
  const [plan, setPlan] = useState<ScorecardPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const c = await api.cycleReviewers(cycleId, signal);
        setReviewers(c.reviewers);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [cycleId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function preview(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPlan(await api.previewScorecard(cycleId, csv));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importScorecard(cycleId, csv);
      setNotice(
        `Imported ${result.applied} score${result.applied === 1 ? '' : 's'} across ` +
          `${result.assignments} review${result.assignments === 1 ? '' : 's'}.`,
      );
      setPlan(null);
      setCsv('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>
            Offline scorecards
          </h2>
          <button type="button" className="btn secondary small" onClick={onBack}>
            Back
          </button>
        </div>
        <p className="meta">
          {/* Said here rather than in a comment nobody reads, because the
              person choosing this route is the one who should know its cost. */}
          A fallback, so a reviewer without access does not hold up a decision. An imported
          scorecard is checked against this cycle&rsquo;s rubric version and writes the same
          audit trail as scoring in the app &mdash; but it carries no evidence that the person
          who filled it in was the person it was sent to, and no moment at which they were asked
          about a conflict. Score in the app where you can.
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
      </section>

      <section className="panel">
        <h3>Send a scorecard</h3>
        {reviewers === null ? (
          <p className="meta" aria-live="polite">
            Loading…
          </p>
        ) : reviewers.length === 0 ? (
          <p className="meta">Nobody is assigned to review in this cycle yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reviewer</th>
                  <th scope="col" className="num">
                    Assigned
                  </th>
                  <th scope="col">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reviewers.map((r) => (
                  <tr key={r.reviewerUserId}>
                    <th scope="row">{r.email}</th>
                    <td className="num">{r.assigned}</td>
                    <td>
                      {/*
                        * A real link, not a fetch. The response is a CSV with
                        * a Content-Disposition, so the browser saves it; going
                        * through fetch would mean building a blob and a
                        * synthetic click for no gain.
                        */}
                      <a
                        className="btn secondary small"
                        href={`/api/cycles/${encodeURIComponent(cycleId)}/scorecard/${encodeURIComponent(r.reviewerUserId)}`}
                      >
                        Download<span className="sr-only"> {r.email}&rsquo;s scorecard</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Read one back</h3>
        <label className="stack">
          <span>Paste the filled-in file</span>
          <textarea
            id="scorecard-csv"
            rows={8}
            value={csv}
            placeholder="assignment_id,application_id,…"
            onChange={(e) => {
              setCsv(e.target.value);
              // A plan describes a file. Once the file changes it describes
              // nothing, and leaving it on screen invites somebody to apply
              // the one they just replaced.
              setPlan(null);
            }}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy || csv.trim() === ''}
            onClick={() => void preview()}
          >
            Check it
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || plan === null || !plan.ok}
            onClick={() => void apply()}
          >
            Import
          </button>
        </div>

        {plan && (
          <>
            {plan.issues.length > 0 ? (
              <>
                <p className="banner danger" role="alert">
                  This file was not imported. Nothing has changed.
                </p>
                <ul className="answers">
                  {plan.issues.map((i, idx) => (
                    <li key={`${i.row}-${idx}`}>
                      {i.row === null ? '' : `Row ${i.row}: `}
                      {i.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className="banner" role="status">
                  Ready: {plan.totalScores} score{plan.totalScores === 1 ? '' : 's'} would change,
                  against rubric version {plan.rubricVersion}.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Reviewer</th>
                        <th scope="col" className="num">
                          New or changed
                        </th>
                        <th scope="col" className="num">
                          Cleared
                        </th>
                        <th scope="col" className="num">
                          Unchanged
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.assignments.map((a) => (
                        <tr key={a.assignmentId}>
                          <th scope="row">{a.organization}</th>
                          <td>{a.reviewerEmail}</td>
                          <td className="num">{a.scored}</td>
                          <td className="num">{a.cleared}</td>
                          <td className="num">{a.unchanged}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
