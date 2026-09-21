/**
 * Who is covering what, and the disclosures somebody has to act on.
 *
 * WHY THIS SCREEN EXISTS. Two endpoints had no door. `reviewCoverage` has
 * answered "which applications are short of reviewers" since Phase 3 and
 * nothing ever asked it, so the question it exists to prevent -- finding out
 * at the deadline that six applications have one reviewer and two have four --
 * was still answered by somebody counting rows by hand.
 *
 * AND A DECLARED CONFLICT HAD NOWHERE TO GO. A reviewer who disclosed one was
 * blocked from scoring, the coverage grid showed a number, and acting on it
 * required an assignment id that appeared on no screen. So the disclosure sat
 * there until the deadline -- punishing the reviewer who did the right thing
 * by making it early, which is the incentive a conflict policy least wants.
 *
 * ADMIN ONLY, and not because the numbers are sensitive. The conflict notes
 * are a reviewer's own words about a third party, and both endpoints list
 * every application in the cycle rather than one reviewer's own.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { Coverage, OutstandingConflict } from './api';

interface Props {
  cycleId: string;
  cycleName: string;
}

export function ReviewCoverage({ cycleId, cycleName }: Props): ReactElement {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [conflicts, setConflicts] = useState<OutstandingConflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which disclosure is open, and what is being written about it. */
  const [acting, setActing] = useState<{ id: string; kind: 'clear' | 'recuse' } | null>(null);
  const [words, setWords] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [c, k] = await Promise.all([
          api.reviewCoverage(cycleId, signal),
          api.cycleConflicts(cycleId, signal),
        ]);
        setCoverage(c);
        setConflicts(k.conflicts);
        setError(null);
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

  async function act(): Promise<void> {
    if (!acting) return;
    const row = (conflicts ?? []).find((k) => k.assignmentId === acting.id);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (acting.kind === 'clear') {
        await api.clearConflict(acting.id, words.trim());
        setNotice(
          `Recorded as not a conflict. ${row?.reviewerEmail ?? 'The reviewer'} can score ` +
            `${row?.organizationName ?? 'it'} again.`,
        );
      } else {
        await api.recuse(acting.id, words.trim());
        setNotice(
          `${row?.reviewerEmail ?? 'The reviewer'} has been recused from ` +
            `${row?.organizationName ?? 'it'}. That application now needs another reviewer.`,
        );
      }
      setActing(null);
      setWords('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        Review coverage
      </h2>
    </div>
  );

  if (error && !coverage) {
    return (
      <section className="panel">
        {heading}
        <p className="banner danger" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!coverage || !conflicts) {
    return (
      <section className="panel">
        {heading}
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      </section>
    );
  }

  const actingRow = conflicts.find((k) => k.assignmentId === acting?.id) ?? null;

  return (
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          {cycleName}. Every submitted application should have {coverage.target} live reviewers.
          Recused and withdrawn assignments are not counted, so an application whose only
          reviewer stepped away reads as zero rather than one.
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
        {coverage.under > 0 ? (
          <p className="banner">
            {coverage.under} application{coverage.under === 1 ? ' has' : 's have'} fewer than{' '}
            {coverage.target} reviewers.
          </p>
        ) : (
          <p className="meta">Every application has its full complement of reviewers.</p>
        )}
      </section>

      <section className="panel">
        <h3>Disclosures to act on ({conflicts.length})</h3>
        <p className="meta">
          {/*
            Said on the screen, because the reviewer cannot act on it and will
            not know why their sheet is locked unless somebody here does.
          */}
          A reviewer who declares a conflict cannot score that application until this is
          resolved. Recording that it is not a conflict keeps the declaration on the record and
          lets them carry on; recusing them removes the assignment and leaves the application
          short a reviewer.
        </p>
        {conflicts.length === 0 ? (
          <p className="meta">Nothing is waiting.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Declared</th>
                  <th scope="col">What they said</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((k) => (
                  <tr key={k.assignmentId}>
                    <th scope="row">
                      {k.organizationName ?? 'Unknown organization'}
                      {k.projectTitle && <span className="meta"> — {k.projectTitle}</span>}
                    </th>
                    <td>{k.reviewerEmail}</td>
                    <td>{new Date(k.declaredAt).toLocaleDateString('en-US')}</td>
                    <td>{k.note ?? '—'}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={busy}
                        onClick={() => {
                          setActing({ id: k.assignmentId, kind: 'clear' });
                          setWords('');
                        }}
                      >
                        Not a conflict
                        <span className="sr-only">
                          {' '}
                          &mdash; {k.reviewerEmail} on {k.organizationName ?? 'this application'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={busy}
                        onClick={() => {
                          setActing({ id: k.assignmentId, kind: 'recuse' });
                          setWords('');
                        }}
                      >
                        Recuse
                        <span className="sr-only">
                          {' '}
                          &mdash; {k.reviewerEmail} from {k.organizationName ?? 'this application'}
                        </span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {actingRow && acting && (
          <div className="panel-decide">
            <h3 tabIndex={-1} ref={(el) => el?.focus()}>
              {acting.kind === 'clear'
                ? `Record that this is not a conflict`
                : `Recuse ${actingRow.reviewerEmail}`}
            </h3>
            <p className="meta">
              {actingRow.reviewerEmail} on {actingRow.organizationName ?? 'this application'}.{' '}
              {acting.kind === 'clear'
                ? 'Their declaration stays on the record. This is added beside it, with your name and today’s date.'
                : 'This cannot be undone, and the application will be one reviewer short until somebody else is assigned.'}
            </p>
            <label className="stack">
              <span>
                {acting.kind === 'clear'
                  ? 'What was decided, and on what basis?'
                  : 'Why is this reviewer stepping away?'}
              </span>
              <textarea
                id="conflict-words"
                rows={3}
                value={words}
                onChange={(e) => setWords(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy || words.trim().length < 3}
                onClick={() => void act()}
              >
                {acting.kind === 'clear' ? 'Record it' : 'Recuse them'}
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setActing(null);
                  setWords('');
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Coverage</h3>
        {coverage.rows.length === 0 ? (
          <p className="meta">Nothing has been submitted in this cycle yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Project</th>
                  <th scope="col" className="num">Reviewers</th>
                  <th scope="col" className="num">Submitted</th>
                  <th scope="col" className="num">Blocked</th>
                </tr>
              </thead>
              <tbody>
                {coverage.rows.map((r) => (
                  <tr key={r.application_id}>
                    <th scope="row">{r.organization_name ?? 'Unknown organization'}</th>
                    <td>{r.project_title ?? 'Untitled'}</td>
                    <td className="num">
                      {/*
                        The shortfall is the whole point of the grid, so it is
                        marked rather than left for somebody to compare two
                        columns in their head.
                      */}
                      {r.reviewers < coverage.target ? (
                        <strong data-overdue="true">{r.reviewers}</strong>
                      ) : (
                        r.reviewers
                      )}
                    </td>
                    <td className="num">{r.completed}</td>
                    <td className="num">{r.conflicts > 0 ? <strong>{r.conflicts}</strong> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
