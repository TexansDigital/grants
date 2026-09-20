/**
 * What is wrong with the data, as a worklist.
 *
 * Scanned, not read: the summary comes before the detail, and severity is in
 * the shape of the thing as well as in the number, so an admin opening this
 * between two meetings can tell in one look whether anything is on fire.
 *
 * CHECKS THAT FOUND NOTHING STAY ON SCREEN, showing "none". A health view that
 * hides its passing checks makes the absence of a panel ambiguous between
 * "clean" and "never looked", and the whole value of the screen is being able
 * to believe the quiet.
 *
 * Duplicates are the exception to the list-and-link shape. The merge panel is
 * already the actionable version of that finding, so it renders in place of
 * the row list rather than beside it -- one screen should not show the same
 * thing twice, once as a count and once as a control.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { HealthCheck, HealthReport, HealthRow } from './api';
import { formatCents } from '../../src/lib/money';
import { formatWhen } from './reportWording';
import { Duplicates } from './Duplicates';

interface Props {
  isAdmin: boolean;
  /** Where a finding can be opened, when a screen for it exists. */
  onNavigate: (path: string) => void;
}

/** The merge panel stands in for this check's rows. */
const DUPLICATES = 'duplicate_organizations';

export function DataHealth({ isAdmin, onNavigate }: Props): ReactElement {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .dataHealth(controller.signal)
      .then(setReport)
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      });
    return () => controller.abort();
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  if (error) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>
            Data health
          </h2>
        </div>
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>
            Data health
          </h2>
        </div>
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel" aria-labelledby="health-summary-heading">
        <div className="panel-head">
          <h2 id="health-summary-heading" tabIndex={-1} data-route-heading>
            Data health
          </h2>
          <span className="meta">checked {formatWhen(report.generatedAt)}</span>
        </div>

        <div className="health-summary">
          <p className="bignum" data-severity={report.blocking > 0 ? 'blocking' : 'clear'}>
            {report.blocking}
            <span>{report.blocking === 1 ? 'thing is blocking' : 'things are blocking'}</span>
          </p>
          <p className="bignum">
            {report.attention}
            <span>{report.attention === 1 ? 'needs attention' : 'need attention'}</span>
          </p>
        </div>

        <p className="meta">
          Blocking means money or an obligation cannot move until it is fixed. Nothing here
          changes anything — each row is a record to go and correct.
        </p>
      </section>

      {report.checks.map((check) => (
        <section className="panel" key={check.key}>
          <article
            className="check"
            data-severity={check.severity}
            data-found={check.count > 0 ? 'true' : 'false'}
          >
            <div className="check-head">
              <h3>{check.label}</h3>
              <span className="tag">{check.count === 0 ? 'none' : check.count}</span>
            </div>
            <p className="meta">{check.guidance}</p>

            {check.key === DUPLICATES ? (
              <Duplicates isAdmin={isAdmin} embedded onMerged={reload} />
            ) : (
              <Findings check={check} onNavigate={onNavigate} />
            )}
          </article>
        </section>
      ))}
    </>
  );
}

function Findings({
  check,
  onNavigate,
}: {
  check: HealthCheck;
  onNavigate: (path: string) => void;
}): ReactElement | null {
  if (check.count === 0) return null;
  return (
    <>
      <ul className="findings">
        {check.rows.map((row) => (
          <li key={row.id}>
            <span className="who">{row.title}</span>
            <span className="what">{row.detail}</span>
            <Reference row={row} onNavigate={onNavigate} />
            {row.amountCents !== null && (
              <span className="amount">{formatCents(row.amountCents)}</span>
            )}
          </li>
        ))}
      </ul>
      {check.truncated && (
        <p className="more">
          Showing {check.rows.length} of {check.count}. A check that trips this often is a
          systemic problem, and the next row will not be what tells you that.
        </p>
      )}
    </>
  );
}

/**
 * A way into the record, where one exists.
 *
 * Only two kinds can be opened today. An application has its own screen, and
 * an organization can be pushed through the pipeline's filter, which answers
 * "what else has this nonprofit applied for" — the actual next question.
 *
 * Awards, report obligations and attachments have no detail screen until
 * Phase 4, so those rows show a short id instead. That is not a placeholder
 * for a link: an id is what an admin needs to find the row in the spreadsheet
 * or the export they are about to go and fix it in.
 */
function Reference({
  row,
  onNavigate,
}: {
  row: HealthRow;
  onNavigate: (path: string) => void;
}): ReactElement {
  const href =
    row.kind === 'application'
      ? `/applications/${encodeURIComponent(row.id)}`
      : row.kind === 'organization'
        ? `/pipeline?organization_id=${encodeURIComponent(row.id)}`
        : null;

  if (!href) {
    return (
      <span className="ref" title={row.id}>
        {row.id.slice(0, 8)}
      </span>
    );
  }
  return (
    <button type="button" className="linklike" onClick={() => onNavigate(href)}>
      {row.kind === 'organization' ? 'Applications' : 'Open'}
      <span className="sr-only"> for {row.title}</span>
    </button>
  );
}
