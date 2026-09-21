/**
 * The numbers, and the file that carries them out of here.
 *
 * THE EXPORT IS THE PRODUCT, not this screen. CLAUDE.md: executives never log
 * in, so the CSV is what they receive and it has to stand alone. This page
 * exists so an admin can check the figures before sending them, and it shows
 * the same numbers under the same headings, with the same caveats attached --
 * so what they checked is what the board reads.
 *
 * EVERY TOTAL CARRIES ITS RULE. "Total awarded" is not one number; it is a
 * number plus a rule about cancelled and pending grants. The rule sits under
 * the table rather than in a covering email nobody forwards.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { DashboardData } from './api';
import { formatCents } from '../../src/lib/money';

/** Basis points to a percentage, at the display edge only. */
function rate(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(1)}%`;
}

export function Dashboard(): ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await api.dashboard(signal));
      setError(null);
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
        Dashboard
      </h2>
      {/*
        * A real link, not a fetch. The response carries a
        * Content-Disposition, so the browser saves it.
        */}
      <a className="btn" href="/api/dashboard.csv">
        Download the summary
      </a>
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
  if (!data) {
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
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          The same figures as the downloaded file, under the same headings. Check them here
          before sending.
        </p>
        {data.notAvailable.map((s) => (
          // Said on the screen, not only in the file. An admin who does not
          // know this is missing will be asked for it in the meeting.
          <p key={s} className="banner" role="status">
            Not included: {s}
          </p>
        ))}
      </section>

      <section className="panel">
        <h3>Awards</h3>
        {data.awardTotals.length === 0 ? (
          <p className="meta">No awards yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Fiscal year</th>
                  <th scope="col">Program</th>
                  <th scope="col">Cycle</th>
                  <th scope="col" className="num">Awards</th>
                  <th scope="col" className="num">Committed</th>
                  <th scope="col" className="num">Smallest</th>
                  <th scope="col" className="num">Largest</th>
                </tr>
              </thead>
              <tbody>
                {data.awardTotals.map((r) => (
                  <tr key={`${r.programId}-${r.cycleId ?? 'none'}`}>
                    <th scope="row">{r.fiscalYear ?? '—'}</th>
                    <td>{r.programName}</td>
                    <td>{r.cycleName ?? '—'}</td>
                    <td className="num">{r.awards}</td>
                    <td className="num">{formatCents(r.committedCents)}</td>
                    <td className="num">
                      {r.smallestCents === null ? '—' : formatCents(r.smallestCents)}
                    </td>
                    <td className="num">
                      {r.largestCents === null ? '—' : formatCents(r.largestCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta">
          Cancelled awards are excluded. Awards not yet accepted are included &mdash; money
          offered is money that cannot be offered twice.
        </p>
      </section>

      <section className="panel">
        <h3>Money out</h3>
        {data.disbursement.length === 0 ? (
          <p className="meta">No programs yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col" className="num">Committed</th>
                  <th scope="col" className="num">Scheduled</th>
                  <th scope="col" className="num">Paid</th>
                  <th scope="col" className="num">Not yet scheduled</th>
                  <th scope="col" className="num">Scheduled, not paid</th>
                </tr>
              </thead>
              <tbody>
                {data.disbursement.map((r) => (
                  <tr key={r.programId}>
                    <th scope="row">{r.programName}</th>
                    <td className="num">{formatCents(r.committedCents)}</td>
                    <td className="num">{formatCents(r.scheduledCents)}</td>
                    <td className="num">{formatCents(r.paidCents)}</td>
                    {/*
                      * THREE NUMBERS, NOT TWO. Money nobody has scheduled is a
                      * planning question; money scheduled and unpaid is a
                      * finance question. One "outstanding" figure sends the
                      * wrong person after it.
                      *
                      * Clamped at zero because paid can legitimately exceed
                      * committed — a grant paid and later rescinded — and a
                      * negative in a "remaining" column reads as an error
                      * rather than as the anomaly it is.
                      */}
                    <td className="num">
                      {formatCents(Math.max(0, r.committedCents - r.scheduledCents))}
                    </td>
                    <td className="num">
                      {formatCents(Math.max(0, r.scheduledCents - r.paidCents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta">
          Steward records payment schedules and what finance reports as paid. It does not move
          money. Cancelled payments are listed on an award but not counted here.
        </p>
      </section>

      <section className="panel">
        <h3>Against budget</h3>
        {data.budget.length === 0 ? (
          <p className="meta">No programs yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col" className="num">Budget</th>
                  <th scope="col" className="num">Committed</th>
                  <th scope="col" className="num">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {data.budget.map((b) => (
                  <tr key={b.programId}>
                    <th scope="row">
                      {b.programName}
                      {b.overBudget && (
                        <span className="badge badge-danger"> over budget</span>
                      )}
                    </th>
                    <td className="num">
                      {b.totalBudgetCents === null ? '—' : formatCents(b.totalBudgetCents)}
                    </td>
                    <td className="num">{formatCents(b.committedCents)}</td>
                    <td className="num">
                      {/*
                        * REMAINING GOES NEGATIVE exactly when a program is over
                        * budget -- the case the flag beside it exists for --
                        * and formatCents refuses negative cents, so this threw
                        * and the error boundary replaced the whole page. Found
                        * by opening it; no unit test could have, because the
                        * component was never rendered with an over-budget row.
                        *
                        * Shown as "over by" rather than as a minus sign: a
                        * board reading "-$13,500 remaining" has to do the
                        * translation, and half of them will do it wrong.
                        */}
                      {b.totalBudgetCents === null
                        ? '—'
                        : b.committedCents > b.totalBudgetCents
                          ? `over by ${formatCents(b.committedCents - b.totalBudgetCents)}`
                          : formatCents(b.totalBudgetCents - b.committedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Applications</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Cycle</th>
                <th scope="col" className="num">Received</th>
                <th scope="col" className="num">In review</th>
                <th scope="col" className="num">Awarded</th>
                <th scope="col" className="num">Declined</th>
                <th scope="col" className="num">Funded</th>
              </tr>
            </thead>
            <tbody>
              {data.funnel.map((r) => (
                <tr key={r.cycleId}>
                  <th scope="row">{r.programName}</th>
                  <td>{r.cycleName}</td>
                  <td className="num">{r.received}</td>
                  <td className="num">{r.underReview}</td>
                  <td className="num">{r.awarded}</td>
                  <td className="num">{r.declined}</td>
                  <td className="num">{rate(r.successRateBp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">
          Drafts that were never submitted are not counted as received.
        </p>
      </section>

      <section className="panel">
        <h3>Grant reports</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col" className="num">Open</th>
                <th scope="col" className="num">Submitted</th>
                <th scope="col" className="num">Accepted</th>
                <th scope="col" className="num">Overdue</th>
                <th scope="col" className="num">Compliance</th>
              </tr>
            </thead>
            <tbody>
              {data.compliance.map((r) => (
                <tr key={r.programId}>
                  <th scope="row">{r.programName}</th>
                  <td className="num">{r.open}</td>
                  <td className="num">{r.submitted}</td>
                  <td className="num">{r.accepted}</td>
                  <td className="num">
                    {r.overdue > 0 ? <strong>{r.overdue}</strong> : r.overdue}
                  </td>
                  <td className="num">{rate(r.complianceRateBp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="meta">
          Overdue means past its due date and neither accepted nor waived. A waived report
          counts as compliant &mdash; staff decided it was not required, with a reason.
        </p>
      </section>

      <section className="panel">
        <h3>Impact</h3>
        {data.metrics.length === 0 ? (
          <p className="meta">No impact metrics are defined yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Metric</th>
                  <th scope="col" className="num">Reports counted</th>
                  <th scope="col" className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => (
                  <tr key={m.metricDefinitionId}>
                    <th scope="row">{m.programName}</th>
                    <td>
                      {m.label}
                      {m.unit && <span className="meta"> ({m.unit})</span>}
                    </td>
                    {/* The denominator sits BESIDE the total, because "4,200
                        people served" from six reports out of forty is a
                        different sentence from the same number out of forty. */}
                    <td className="num">{m.reports}</td>
                    <td className="num">
                      {m.total === null
                        ? '—'
                        : m.metricType === 'currency'
                          ? formatCents(Math.round(m.total))
                          : m.total.toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta">
          Only accepted reports are counted. Written answers are not totalled.
        </p>
      </section>
    </>
  );
}
