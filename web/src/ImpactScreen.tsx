/**
 * What the money did, and how much of the picture we have.
 *
 * EVERY FIGURE ON THIS SCREEN IS RENDERED WITH ITS DENOMINATOR, and that is
 * not a stylistic preference. "4,200 people served" is a fact if every grantee
 * has filed and a floor if three of thirteen have, and the number reads
 * identically either way — on its way into a board paper, a league report or a
 * press line, where nobody can see behind it any more. The coverage sentence
 * sits above the numbers, not below them, because somebody copying a figure
 * out of this page should have to read past it.
 *
 * THREE ABSENCES ARE DELIBERATELY DIFFERENT. A metric nobody has answered
 * shows "Not reported yet" and never a zero; a grantee who genuinely reached
 * nobody shows 0; and a written answer shows how many grantees answered and
 * no figure at all, because a summed sentence is a fabrication.
 *
 * NO CHARTS. A bar chart of a number whose denominator is three would be a
 * more confident lie than the number alone. When the thirteen have filed and
 * there is a second year to compare against, a chart earns its place; today
 * it would decorate an absence.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { Impact, ImpactProgram } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  year: number | null;
  onYearChange: (year: number | null) => void;
}

/** A measurement, formatted for its own kind. Currency is integer cents. */
function value(metricType: string, total: number, unit: string | null): string {
  if (metricType === 'currency') return formatCents(total);
  const n = metricType === 'decimal' ? total.toLocaleString() : Math.round(total).toLocaleString();
  return unit ? `${n} ${unit}` : n;
}

/**
 * The sentence that has to be read before the numbers are.
 *
 * Written as prose rather than as a ratio, because "3/13" invites the reader
 * to skip it and a sentence does not. It names the grants nobody has asked
 * separately, since those are not a shortfall by the grantees — they are the
 * Foundation's own outstanding work, and for the thirteen 2025 grants they
 * are currently all of it.
 */
function coverage(p: ImpactProgram): string {
  if (p.obligations === 0 && p.grantsNeverAsked === 0) {
    return 'No grants in this programme yet.';
  }
  if (p.obligations === 0) {
    return `Nothing below has been reported. None of the ${p.grantsNeverAsked} grant${
      p.grantsNeverAsked === 1 ? '' : 's'
    } in this programme has been asked for an update yet.`;
  }
  const asked = `${p.accepted} of ${p.obligations} update${p.obligations === 1 ? '' : 's'} accepted`;
  const money = `covering ${formatCents(p.totalAwardedCents)} of grants`;
  const never =
    p.grantsNeverAsked > 0
      ? `, and ${p.grantsNeverAsked} further grant${
          p.grantsNeverAsked === 1 ? ' has' : 's have'
        } not been asked at all`
      : '';
  return `Based on ${asked}, ${money}${never}.`;
}

export function ImpactScreen({ year, onYearChange }: Props): ReactElement {
  const [data, setData] = useState<Impact | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      try {
        setData(await api.impact(year, c.signal));
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      }
    })();
    return () => c.abort();
  }, [year]);

  if (error) {
    return (
      <section className="panel">
        <h2>Impact</h2>
        <p role="alert">{error.message}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        <h2>Impact</h2>
        <p className="meta">Loading…</p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Impact</h2>
          <span className="meta">
            {year === null ? 'Every year' : `Grant year ${year}`}
          </span>
        </div>

        <p>
          What grantees have reported back, from updates a member of staff has read and accepted.
          Every figure is shown with the share of grants it is drawn from.
        </p>

        {data.years.length > 0 ? (
          <label className="year-picker">
            <span>Grant year</span>
            <select
              id="impact-year"
              value={year === null ? '' : String(year)}
              onChange={(e) => onYearChange(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Every year</option>
              {data.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      {data.programs.length === 0 ? (
        <section className="panel">
          <p className="empty-reason">No programmes yet.</p>
        </section>
      ) : null}

      {data.programs.map((p) => (
        <section className="panel" key={p.programId}>
          <div className="panel-head">
            <h2>{p.programName}</h2>
          </div>

          {/*
            ABOVE the numbers, always. A coverage note under a total is a
            footnote, and footnotes do not travel with a figure somebody has
            copied into a slide.
          */}
          <p className="coverage">{coverage(p)}</p>

          {p.metrics.length === 0 ? (
            <p className="empty-reason">
              This programme has no impact metrics defined, so there is nothing for grantees to
              report against. Metrics are set up per programme, before the report form is built.
            </p>
          ) : (
            <dl className="facts impact-facts">
              {p.metrics.map((m) => (
                <div key={m.metricDefinitionId}>
                  <dt>{m.label}</dt>
                  <dd>
                    {m.metricType === 'text' ? (
                      /*
                        A written answer is never a figure. Said as who
                        answered, so the reader opens the reports to read them.
                      */
                      <span className="meta">
                        {m.answered === 0
                          ? 'Not reported yet'
                          : `${m.answered} grantee${m.answered === 1 ? '' : 's'} answered — read in their updates`}
                      </span>
                    ) : m.total === null ? (
                      /*
                        NOT a zero. "0 people served" and "nobody has told us
                        yet" are different facts, and the first is a libel on
                        the grantees.
                      */
                      <span className="meta">Not reported yet</span>
                    ) : (
                      <>
                        <strong className="impact-number">
                          {value(m.metricType, m.total, m.unit)}
                        </strong>
                        <span className="meta">
                          from {m.answered} update{m.answered === 1 ? '' : 's'}
                        </span>
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </>
  );
}
