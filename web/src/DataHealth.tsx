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
import type { HealthCheck, HealthReport, HealthRow, StorageUsage } from './api';
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
  const [storage, setStorage] = useState<StorageUsage | null>(null);
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
    /*
     * Storage loads BESIDE the report, not inside it, and its failure is
     * swallowed on purpose. It is a cost figure; a 500 from it must not take
     * down the screen that says whether money can move. The panel simply does
     * not render, which is honest -- better than a zero, which would read as
     * "nothing stored" rather than "could not ask".
     */
    api
      .storage(controller.signal)
      .then(setStorage)
      .catch(() => undefined);
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

      {/*
        AFTER the findings, not before. This screen's premise is that what is
        blocking comes first; a cost figure above the blocking rows pushes them
        down for something nobody opened the page to read.
      */}
      {storage && <StoragePanel usage={storage} />}
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

/** Whole gigabytes read better than 1,073,741,824. */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * What R2 is holding, and what it costs.
 *
 * WHY IT IS ON THIS SCREEN AT ALL. The endpoint behind it has existed for a
 * day and nothing rendered it, which makes a request to "flag it if this goes
 * over five dollars a month" impossible to honour: a figure nobody can see
 * flags nothing. This is the panel that makes the promise keepable.
 *
 * The two numbers underneath the cost are the ones that decide whether it
 * grows. Media is never scheduled for deletion by design, so it only ever goes
 * up; the unretained figure is everything on a report that carries no deletion
 * date at all. Both are stated rather than implied, because the decision they
 * point at -- how long a grantee's files are kept -- is one somebody has to
 * take deliberately, and it is much easier to take before there is real
 * footage of real children attached to it.
 */
function StoragePanel({ usage }: { usage: StorageUsage }): ReactElement {
  const cost = usage.estimatedMonthlyUsd;
  return (
    <section className="panel" aria-labelledby="storage-heading">
      <article
        className="storage-usage"
        data-over={usage.overWatchThreshold ? 'true' : 'false'}
      >
        <div className="check-head">
          <h3 id="storage-heading">Files in storage</h3>
          <span className="tag">{formatSize(usage.totalBytes)}</span>
        </div>

        <p className="meta">
          About {cost < 0.01 ? 'less than a cent' : `$${cost.toFixed(2)}`} a month at R2&rsquo;s
          published rate.{' '}
          {usage.overWatchThreshold
            ? 'This is past the $5 a month worth a conversation.'
            : 'Below the $5 a month worth a conversation.'}
        </p>

        <ul className="meta">
          <li>
            {usage.mediaFiles === 0
              ? 'No photographs or video yet.'
              : `${usage.mediaFiles} photo${usage.mediaFiles === 1 ? '' : 's'} and video, ` +
                `${formatSize(usage.mediaBytes)}. Nothing ever deletes these.`}
          </li>
          <li>
            {usage.unretainedBytes === 0
              ? 'Every file on a report has a deletion date.'
              : `${formatSize(usage.unretainedBytes)} attached to reports has no deletion ` +
                'date, so it stays until somebody removes it by hand.'}
          </li>
        </ul>

        <p className="meta">
          Applicants&rsquo; financial documents are destroyed on a schedule after a decision.
          Files a grantee sends back are not, until a retention period is set for them.
        </p>
      </article>
    </section>
  );
}
