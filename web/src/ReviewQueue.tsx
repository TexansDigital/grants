/**
 * What is assigned to me.
 *
 * THE WHOLE POINT OF THE REVIEWER ROLE. Until now the queue endpoint existed
 * and nothing called it, so an outside consultant given a Steward account
 * signed in and landed on a pipeline that answered 404 for every row -- which
 * is correct scoping and reads as a broken system.
 *
 * SCOPED BY THE SERVER, not by this screen. The endpoint returns only
 * assignments belonging to the signed-in user, so there is no filter here to
 * get wrong.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { QueueRow } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  onOpenSheet: (assignmentId: string) => void;
}

export function ReviewQueue({ onOpenSheet }: Props): ReactElement {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await api.reviewQueue(signal);
      setRows(r.assignments);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        My reviews
      </h2>
    </div>
  );

  if (error) {
    return (
      <section className="panel">
        {heading}
        <p className="banner danger" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!rows) {
    return (
      <section className="panel">
        {heading}
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      {heading}
      {rows.length === 0 ? (
        <p className="meta">
          Nothing is assigned to you right now. When an administrator assigns you an application,
          it appears here.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Application</th>
                <th scope="col" className="num">
                  Requested
                </th>
                <th scope="col">Your review</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.review_assignment_id}>
                  <th scope="row">{r.project_title ?? 'Untitled application'}</th>
                  <td className="num">
                    {r.requested_amount_cents === null ? '—' : formatCents(r.requested_amount_cents)}
                  </td>
                  <td>
                    {/*
                      A DECLARED CONFLICT IS NOT ALWAYS A BLOCKED ONE. Until
                      0023 it was, and this column said "Conflict declared"
                      forever -- next to a disabled button -- even after an
                      admin had looked into it and decided it was not one.
                    */}
                    {r.conflict_declared_at && !r.conflict_cleared_at
                      ? 'Conflict declared'
                      : r.completed_at
                        ? 'Submitted'
                        : r.conflict_declared_at
                          ? 'Disclosed, resolved'
                          : 'Not started'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={Boolean(r.conflict_declared_at && !r.conflict_cleared_at)}
                      onClick={() => onOpenSheet(r.review_assignment_id)}
                    >
                      {r.completed_at ? 'Review' : 'Score'}
                      <span className="sr-only"> {r.project_title ?? 'this application'}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
