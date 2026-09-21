/**
 * The grantee's one page.
 *
 * Your award, the amount, what is due when, and one button to file the open
 * report. CLAUDE.md sets the bar at three clicks to submit, so the outstanding
 * report is not something to go looking for: it is the first thing on the page
 * with a button on it, and everything else is reference.
 *
 * MOBILE FIRST, and meant literally. A program director files this from a
 * phone between two other jobs. Nothing here is a table, nothing needs
 * horizontal scrolling, and every control clears 44px.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatCents } from '../../src/lib/money';
import { applicantApi } from './applicantApi';
import { formatBytes } from './uploadFile';
import type { AwardSummary, GranteeHomeResponse, ReportState } from './granteeApi';
import { formatDay, reportHeadline, reportTone } from './reportWording';

// Re-exported because the report page renders the same dates. One definition.
export { formatDay, formatMoment, daysUntil, reportHeadline, reportTone } from './reportWording';

const CHIP_LABEL: Record<ReportState, string> = {
  open: 'To do',
  in_progress: 'In progress',
  changes_requested: 'Changes asked for',
  submitted: 'Sent',
  accepted: 'Accepted',
  waived: 'Not required',
  not_open_yet: 'Not open yet',
  no_form_yet: 'Coming soon',
};

interface Props {
  data: GranteeHomeResponse;
  onOpenReport: (reportPeriodId: string) => void;
  now?: Date;
}

export function GranteeHome({ data, onOpenReport, now = new Date() }: Props): ReactElement {
  const outstanding = data.awards
    .flatMap((a) => a.reports.map((r) => ({ award: a, report: r })))
    .filter((x) => x.report.outstanding)
    .sort((a, b) => a.report.dueDate.localeCompare(b.report.dueDate));

  return (
    <>
      <div className="section-head">
        <h2 tabIndex={-1} data-route-heading>
          {data.organization.name ?? 'Your grants'}
        </h2>
        <p>
          Everything you hold from the Houston Texans Foundation, and what is due when.
        </p>
      </div>

      {data.awards.length === 0 && (
        <div className="card portal-empty">
          <p>
            There are no grants on this account yet. If you have been told otherwise, reply to
            the email that brought you here and we will sort it out.
          </p>
        </div>
      )}

      {outstanding.length > 0 && (
        <section className="portal-todo" aria-labelledby="todo-heading">
          <h3 id="todo-heading">
            {outstanding.length === 1 ? 'One report to file' : `${outstanding.length} reports to file`}
          </h3>
          <ul className="portal-list">
            {outstanding.map(({ award, report }) => (
              <li key={report.id}>
                <div className="portal-todo-row">
                  <div>
                    <p className="portal-todo-title">{report.label}</p>
                    <p className="portal-meta">
                      {award.program} · {formatCents(award.amountCents)}
                    </p>
                    <p
                      className="portal-due"
                      data-tone={reportTone(report, now)}
                    >
                      {reportHeadline(report, now)}
                    </p>
                    {report.feedback && (
                      <p className="portal-feedback">
                        <strong>What we asked for:</strong> {report.feedback}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpenReport(report.id)}
                  >
                    {report.state === 'in_progress' ? 'Carry on' : 'File this report'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.awards.map((award) => (
        <AwardCard key={award.id} award={award} onOpenReport={onOpenReport} now={now} />
      ))}
    </>
  );
}

function AwardCard({
  award,
  onOpenReport,
  now,
}: {
  award: AwardSummary;
  onOpenReport: (id: string) => void;
  now: Date;
}): ReactElement {
  return (
    <section className="card portal-award" aria-labelledby={`award-${award.id}`}>
      <div className="portal-award-head">
        <h3 id={`award-${award.id}`}>{award.program}</h3>
        {/* The amount is the fact a grantee is looking for, so it is the
            largest thing on the card and it is never abbreviated. */}
        <p className="portal-amount">{formatCents(award.amountCents)}</p>
      </div>
      <p className="portal-meta">
        Awarded {formatDay(award.awardedAt)}
        {award.termStart && award.termEnd && (
          <> · Grant period {formatDay(award.termStart)} to {formatDay(award.termEnd)}</>
        )}
      </p>

      {award.reports.length === 0 ? (
        <p className="portal-meta">No reports are scheduled on this grant.</p>
      ) : (
        <ul className="portal-list">
          {award.reports.map((report) => (
            <li key={report.id}>
              <div className="portal-report-row">
                <div>
                  <p className="portal-report-title">
                    {report.label}
                    <span className="portal-chip" data-tone={reportTone(report, now)}>
                      {CHIP_LABEL[report.state]}
                    </span>
                  </p>
                  <p className="portal-due" data-tone={reportTone(report, now)}>
                    {reportHeadline(report, now)}
                  </p>
                </div>
                {report.outstanding && (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => onOpenReport(report.id)}
                  >
                    Open
                  </button>
                )}
              </div>
              {report.attachments.length > 0 && <FiledFiles files={report.attachments} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What was filed with a report, readable again.
 *
 * WHY. A grantee could attach documents to a report and never see them
 * afterwards -- and "did I send the right budget?" is asked most often AFTER
 * submitting, which is exactly when the page could not answer it. The same gap
 * the application form had, in the place a grantee visits more often.
 *
 * ONE FAILURE MESSAGE PER FILE, not a banner at the top of a page that may
 * hold several grants and a dozen reports. Somebody who cannot open the
 * January budget needs to be told beside the January budget.
 */
function FiledFiles({
  files,
}: {
  files: { id: string; filename: string; sizeBytes: number }[];
}): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  async function open(id: string): Promise<void> {
    setBusy(id);
    setFailed((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const grant = await applicantApi.downloadUrl(id);
      window.location.assign(grant.url);
    } catch (e) {
      setFailed((prev) => ({
        ...prev,
        [id]:
          e instanceof Error && e.message
            ? e.message
            : 'That file could not be opened just now.',
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="portal-files">
      {files.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            className="linklike"
            disabled={busy === f.id}
            onClick={() => void open(f.id)}
          >
            {busy === f.id ? 'Opening…' : f.filename}
          </button>
          <span className="portal-meta"> {formatBytes(f.sizeBytes)}</span>
          {failed[f.id] && (
            <p className="error" role="alert">
              {failed[f.id]}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
