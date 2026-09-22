/**
 * The compliance desk: every report obligation across the portfolio.
 *
 * The question this screen exists to answer is "who owes us what, and what is
 * late" -- and then, one click later, "what did they actually say". So it is a
 * dense sortable list with the decision buttons on the detail, not a dashboard
 * of counts nobody can act on.
 *
 * Filters live in the URL, as on the pipeline and for the same reason:
 * "everything overdue in the 2026 program" becomes a link somebody can paste
 * into an email rather than a sequence of clicks described in prose.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { BulkGenerateResult, PortfolioRow, ProgramRow, StaffReport } from './api';
import { formatCents } from '../../src/lib/money';
import { formatDay } from './reportWording';

interface Props {
  programs: ProgramRow[];
  isAdmin: boolean;
  query: string;
  onQueryChange: (next: string) => void;
}

const STATUSES = [
  'scheduled',
  'open',
  'submitted',
  'revisions_requested',
  'accepted',
  'waived',
] as const;

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  open: 'Open',
  submitted: 'Filed, awaiting us',
  revisions_requested: 'Sent back',
  accepted: 'Accepted',
  waived: 'Waived',
};

export function Reports({ programs, isAdmin, query, onQueryChange }: Props): ReactElement {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value === '') next.delete(key);
      else next.set(key, value);
      onQueryChange(next.toString());
    },
    [onQueryChange, params],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .reports(params.toString(), controller.signal)
      .then((out) => {
        setRows(out.rows);
        setTotal(out.total);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [params, reloadKey]);

  const outstanding = rows.filter((r) => r.overdue).length;

  return (
    <>
      <div className="panel-head">
        <h2 tabIndex={-1} data-route-heading>
          Grant reports
        </h2>
        <p className="meta" aria-live="polite">
          {loading
            ? 'Loading…'
            : `${rows.length} of ${total} obligation${total === 1 ? '' : 's'}` +
              (outstanding > 0 ? ` · ${outstanding} overdue` : '')}
        </p>
      </div>

      {isAdmin && <GeneratePeriods />}

      <div className="filters">
        <label className="filter">
          <span>Program</span>
          <select value={params.get('program_id') ?? ''} onChange={(e) => set('program_id', e.target.value)}>
            <option value="">All programs</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Status</span>
          <select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Overdue only</span>
          <select value={params.get('overdue') ?? ''} onChange={(e) => set('overdue', e.target.value)}>
            <option value="">No</option>
            <option value="true">Yes</option>
          </select>
        </label>
      </div>

      {error && (
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="empty">Nothing matches these filters.</p>
      )}

      {rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Report obligations across every grant</caption>
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Report</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
                <th scope="col">Chased</th>
                <th scope="col">Award</th>
                <th scope="col">Spent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reportPeriodId}>
                  <td>
                    <button
                      type="button"
                      className="rowlink"
                      onClick={() => setOpenId(r.reportPeriodId)}
                    >
                      {r.organizationName}
                    </button>
                    <span className="meta">{r.programName}</span>
                  </td>
                  <td>{r.label}</td>
                  <td>
                    {formatDay(r.dueDate)}
                    {r.overdue && (
                      <span className="meta strong" data-overdue="true">
                        {Math.abs(r.daysUntilDue)} day{Math.abs(r.daysUntilDue) === 1 ? '' : 's'} late
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`badge badge-${r.status}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td>
                    {/*
                      HAVE WE ASKED? An overdue row on its own is ambiguous
                      between a nonprofit ignoring us and a nonprofit nobody
                      ever contacted, and those call for opposite
                      conversations. "Not yet" next to a red date is the
                      Foundation's problem, not the grantee's.
                    */}
                    {r.reminderCount === 0 ? (
                      r.overdue ? (
                        <span className="meta strong" data-overdue="true">
                          Not yet
                        </span>
                      ) : (
                        <span className="meta">&mdash;</span>
                      )
                    ) : (
                      <>
                        {r.reminderCount}
                        {r.reminderLastSentAt && (
                          <span className="meta"> {formatDay(r.reminderLastSentAt)}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="num">{formatCents(r.awardedAmountCents)}</td>
                  <td className="num">
                    {r.fundsSpentCents === null ? '—' : formatCents(r.fundsSpentCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <ReportDetail
          reportPeriodId={openId}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            setOpenId(null);
            setReloadKey((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

type Decision = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string };

function ReportDetail({
  reportPeriodId,
  isAdmin,
  onClose,
  onDecided,
}: {
  reportPeriodId: string;
  isAdmin: boolean;
  onClose: () => void;
  onDecided: () => void;
}): ReactElement {
  const [data, setData] = useState<StaffReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState('');
  const [decision, setDecision] = useState<Decision>({ kind: 'idle' });

  useEffect(() => {
    const controller = new AbortController();
    api
      .report(reportPeriodId, controller.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      });
    return () => controller.abort();
  }, [reportPeriodId]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setDecision({ kind: 'working' });
      try {
        await fn();
        onDecided();
      } catch (e) {
        setDecision({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'That did not go through. Try again.',
        });
      }
    },
    [onDecided],
  );

  if (error) {
    return (
      <section className="panel">
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const latest = data.submissions[0] ?? null;
  const canDecide = isAdmin && data.period.status === 'submitted';
  const canWaive =
    isAdmin && data.period.status !== 'accepted' && data.period.status !== 'waived';

  return (
    <section className="panel" aria-labelledby="report-detail-heading">
      <div className="panel-head">
        <h3 id="report-detail-heading">
          {data.award.organizationName} — {data.period.label}
        </h3>
        <button type="button" className="btn secondary small" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="facts">
        <div>
          <dt>Program</dt>
          <dd>{data.award.programName}</dd>
        </div>
        <div>
          <dt>Award</dt>
          <dd>{formatCents(data.award.awardedAmountCents)}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{formatDay(data.period.dueDate)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABEL[data.period.status] ?? data.period.status}</dd>
        </div>
      </dl>

      {data.period.waivedReason && (
        <p className="banner">
          <strong>Waived:</strong> {data.period.waivedReason}
        </p>
      )}

      {data.submissions.length === 0 && (
        <p className="empty">Nothing has been filed against this report yet.</p>
      )}

      {data.submissions.map((s, i) => (
        <article key={s.id} className="review-section">
          <div className="review-head">
            <h4>
              {i === 0 && data.submissions.length > 1 ? 'Latest attempt' : `Filed ${formatDay(s.submittedAt)}`}
            </h4>
            <span className="meta">
              {s.submittedBy ?? 'unknown'}
              {s.acceptedAt && ' · accepted'}
            </span>
          </div>

          {s.adminFeedback && (
            <p className="banner">
              <strong>We asked for:</strong> {s.adminFeedback}
            </p>
          )}

          {s.metrics.length > 0 && (
            <dl className="facts">
              {s.metrics.map((m) => (
                <div key={m.metricKey}>
                  <dt>{m.label}</dt>
                  <dd className="bignum">{m.display ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}

          <dl className="review-list">
            {s.answers.map((a) => (
              <div className="review-row" key={a.fieldKey}>
                <dt>{a.label}</dt>
                <dd>{a.display ?? <span className="meta">Not answered</span>}</dd>
              </div>
            ))}
          </dl>

          {s.attachments.length > 0 && (
            <ul className="upload-list">
              {s.attachments.map((f) => (
                <li key={f.id}>
                  <span className="upload-name">{f.filename}</span>
                  <span className="upload-size">{Math.round(f.sizeBytes / 1024)} KB</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}

      {decision.kind === 'error' && (
        <p className="banner danger" role="alert">
          {decision.message}
        </p>
      )}

      {canDecide && latest && (
        <div className="panel-decide">
          <label className="filter">
            <span>What needs to change, if anything</span>
            {/* Deliberately above both buttons, and required by the server for
                the send-back. A nonprofit cannot act on "changes requested". */}
            <textarea
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Please break the spend out by site."
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={decision.kind === 'working'}
              onClick={() => act(() => api.acceptReport(reportPeriodId))}
            >
              Accept this report
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={decision.kind === 'working' || feedback.trim().length < 10}
              onClick={() => act(() => api.requestReportRevisions(reportPeriodId, feedback))}
            >
              Send back with these notes
            </button>
          </div>
        </div>
      )}

      {canWaive && (
        <div className="danger-row">
          <button
            type="button"
            className="linklike danger"
            disabled={decision.kind === 'working'}
            onClick={() => {
              const reason = window.prompt('Why is this report not required?');
              if (reason && reason.trim().length >= 5) {
                void act(() => api.waiveReport(reportPeriodId, reason));
              }
            }}
          >
            Waive this report
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Create the report obligations for grants that have none.
 *
 * WHY THIS BUTTON EXISTS AT ALL. Until it did, nothing in the running system
 * could produce a report period. The generator was written and tested in
 * Phase 5 and reachable from nowhere, so an imported grant was a grant nobody
 * would ever be asked to report on -- the portal lists periods, this desk
 * lists periods, and an award with none appeared in neither. The data health
 * check that counts them was the only thing that knew.
 *
 * It sits here rather than on the health screen because this is where the
 * person who manages report obligations already works, and because health
 * stays read-only: it diagnoses, this acts.
 *
 * Safe to press twice. The generator refuses an award that already has
 * periods rather than merging into it -- once a grantee has been told a date,
 * regenerating could move it.
 */
function GeneratePeriods(): ReactElement {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'done'; result: BulkGenerateResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const run = useCallback(async () => {
    const ok = window.confirm(
      'Create report obligations for every grant that has none? ' +
        'Grantees will be asked to file on the dates this works out.',
    );
    if (!ok) return;
    setState({ kind: 'working' });
    try {
      setState({ kind: 'done', result: await api.generateReportPeriods() });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'That did not go through. Try again.',
      });
    }
  }, []);

  return (
    <div className="panel-decide">
      <div className="actions">
        <button
          type="button"
          className="btn secondary small"
          disabled={state.kind === 'working'}
          onClick={run}
        >
          {state.kind === 'working' ? 'Working…' : 'Create missing report obligations'}
        </button>
      </div>

      {state.kind === 'error' && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === 'done' && (
        <div role="status">
          <p className="meta">
            {state.result.periodsCreated === 0
              ? 'Nothing to do — every grant with a term already has its report obligations.'
              : `Created ${state.result.periodsCreated} report obligation` +
                `${state.result.periodsCreated === 1 ? '' : 's'} across ` +
                `${state.result.generated.length} grant` +
                `${state.result.generated.length === 1 ? '' : 's'}. Reload to see them.`}
          </p>
          {state.result.skipped.length > 0 && (
            <ul className="tally">
              {state.result.skipped.map((s) => (
                <li key={s.awardId}>
                  <span className="meta strong" data-overdue="true">
                    {s.skipped}
                  </span>
                  <span className="ref">{s.awardId.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.result.more && (
            <p className="meta">
              More grants still need obligations than one run will take. Press it again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
