/**
 * What the reviewers said, and the decision that follows it.
 *
 * ADMIN ONLY. This is the one screen in the system that shows one reviewer's
 * scores next to another's, and it is the reason that data has its own
 * endpoint rather than riding along on the application detail.
 *
 * TWO THINGS DELIBERATELY NOT HERE.
 *
 * No score normalisation. It was considered and dropped: adjusting for a
 * systematically harsh scorer means telling a decision-maker a number no
 * reviewer gave, and at 100 to 400 applications a year the per-reviewer
 * averages below are enough to SEE the harsh scorer without inventing figures.
 *
 * No email. Recording a decline here sends nothing, because CLAUDE.md requires
 * that a decline is never sent automatically and the surest way to keep that
 * true is for this screen to have no way to send one.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import { formatCents, parseCurrencyToCents, MoneyParseError } from '../../src/lib/money';
import { PaymentLedger } from './PaymentLedger';
import { AwardPaperwork } from './AwardPaperwork';
import type { ScoreSummary } from './api';

const WEIGHT_ONE_BP = 10000;

interface Props {
  applicationId: string;
  /** Null until the application is decided; then the decision is settled. */
  decidedAt: string | null;
  /** The application's own status, so an awarded one can be given its award. */
  decidedStatus: string | null;
  /** The award already on this application, if one was created earlier. */
  existingAwardId: string | null;
  onDecided: () => void;
}

function formatScore(bp: number): string {
  return (bp / WEIGHT_ONE_BP).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** The part of an address before the @, so a wide table stays readable. */
function shortName(email: string): string {
  return email.split('@')[0] ?? email;
}

export function DecisionPanel({
  applicationId,
  decidedAt,
  decidedStatus,
  existingAwardId,
  onDecided,
}: Props): ReactElement | null {
  const [summary, setSummary] = useState<ScoreSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  /** The award form, shown once the decision says awarded. */
  const [amount, setAmount] = useState('');
  const [announce, setAnnounce] = useState('');
  const [termStart, setTermStart] = useState('');
  const [termEnd, setTermEnd] = useState('');
  const [awardNotice, setAwardNotice] = useState<string | null>(null);
  /** Set once an award exists, so its payment ledger can be shown. */
  const [awardId, setAwardId] = useState<string | null>(existingAwardId);

  /*
   * NO LOCAL toCents. This used to be `Math.round(Number(dollars) * 100)`,
   * which is the exact thing money.ts's header forbids -- "never
   * `parseFloat(x) * 100`, which turns 25000.07 into 2500006.9999999995" --
   * and it was sitting on an AWARD AMOUNT. parseCurrencyToCents does it with
   * string arithmetic, refuses more than two decimal places and enforces
   * MAX_CENTS, none of which the local version did.
   */
  let awardCents: number | null = null;
  let amountError: string | null = null;
  if (amount.trim() !== '') {
    try {
      awardCents = parseCurrencyToCents(amount);
    } catch (e) {
      amountError = e instanceof MoneyParseError ? e.message : 'That is not an amount.';
    }
  }

  async function createAward(): Promise<void> {
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    try {
      const result = await api.createAward(applicationId, {
        awardedAmountCents: awardCents!,
        announcementDate: announce ? new Date(`${announce}T12:00:00Z`).toISOString() : null,
        termStart: termStart ? new Date(`${termStart}T12:00:00Z`).toISOString() : null,
        termEnd: termEnd ? new Date(`${termEnd}T12:00:00Z`).toISOString() : null,
      });
      setAwardNotice(
        `Award recorded: ${formatCents(result.awardedAmountCents)}, pending acceptance. ` +
          'The award letter can now be sent from the cycle\u2019s letters page.',
      );
      setAwardId(result.awardId);
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setSummary(await api.scoreSummary(applicationId, signal));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // A reviewer reaching this component at all would be a routing bug,
        // and the API answers 404. Say nothing rather than render an error
        // that tells them a comparison exists.
        setSummary(null);
      }
    },
    [applicationId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function decide(): Promise<void> {
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    try {
      await api.decide(applicationId, status, notes.trim() || null);
      onDecided();
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

  if (!summary) return null;

  const { reviewers, byCriterion, rubric } = summary;
  const outstanding = reviewers.filter((r) => r.completedAt === null).length;

  return (
    <section className="panel">
      <h3>Reviews</h3>
      {rubric === null ? (
        <p className="meta">This cycle has no rubric, so there is nothing to score against.</p>
      ) : reviewers.length === 0 ? (
        <p className="meta">Nobody is assigned to review this application yet.</p>
      ) : (
        <>
          <p className="meta">
            {rubric.name}, version {rubric.version}, out of{' '}
            {formatScore(rubric.maxTotalScoreBp)}.{' '}
            {summary.meanCompletedBp === null ? (
              <>No review has been submitted yet.</>
            ) : (
              <>
                Average of submitted reviews:{' '}
                <strong>{formatScore(summary.meanCompletedBp)}</strong>.
                {/* Unfinished sheets are excluded from that average, because a
                    half-scored sheet is low for a reason that has nothing to
                    do with the application. Saying so, rather than letting the
                    number be quietly partial. */}
                {outstanding > 0 && ` ${outstanding} still outstanding, not counted.`}
              </>
            )}
          </p>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  {reviewers.map((r) => (
                    <th key={r.assignmentId} scope="col" className="num">
                      {shortName(r.reviewerEmail)}
                      {r.completedAt === null && <span className="meta"> (open)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byCriterion.map((c) => (
                  <tr key={c.criterionId}>
                    <th scope="row">
                      {c.label}
                      <span className="meta"> / {c.maxScore} &times; {formatScore(c.weightBp)}</span>
                    </th>
                    {c.scores.map((cell) => (
                      <td key={cell.assignmentId} className="num" title={cell.comment ?? ''}>
                        {cell.score === null ? '—' : cell.score}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Weighted total</th>
                  {reviewers.map((r) => (
                    <td key={r.assignmentId} className="num">
                      <strong>{formatScore(r.totalBp)}</strong>
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          {byCriterion.some((c) => c.scores.some((s) => s.comment)) && (
            <>
              <h3>Comments</h3>
              <dl className="answers">
                {byCriterion.flatMap((c) =>
                  c.scores
                    .filter((s) => s.comment)
                    .map((s) => (
                      <div key={`${c.criterionId}-${s.assignmentId}`}>
                        <dt>
                          {c.label} &mdash;{' '}
                          {shortName(
                            reviewers.find((r) => r.assignmentId === s.assignmentId)
                              ?.reviewerEmail ?? '',
                          )}
                        </dt>
                        <dd>{s.comment}</dd>
                      </div>
                    )),
                )}
              </dl>
            </>
          )}
        </>
      )}

      {/*
        The paperwork and then the ledger, once an award exists. Below the
        reviews and the decision, because that is the order the work happens
        in: score, decide, record the award, collect what is needed before
        funds move, then schedule the money.
      */}
      {awardId && (
        <>
          <AwardPaperwork awardId={awardId} />
          <PaymentLedger awardId={awardId} />
        </>
      )}

      <h3>Decision</h3>
      {decidedAt ? (
        <>
          <p className="meta">
            Decided on {new Date(decidedAt).toLocaleDateString('en-US')}. A decision is recorded
            once; changing one is not something this screen can do.
          </p>
          {decidedStatus === 'awarded' && (
            /*
             * A DECISION IS NOT AN AWARD, which is why this is a second,
             * deliberate act. The board approves "up to $50,000" and finance
             * settles the number; a grantee declines; the terms are
             * renegotiated. And the award letter cannot go until this row
             * exists, because it carries the amount.
             */
            <div className="panel-decide">
              <h3>Award record</h3>
              {awardNotice ? (
                <p className="banner" role="status">
                  {awardNotice}
                </p>
              ) : (
                <>
                  {fieldErrors.map((f) => (
                    <p key={f.field} className="banner danger" role="alert">
                      {f.message}
                    </p>
                  ))}
                  <label className="stack">
                    <span>Amount awarded</span>
                    <input
                      id="award-amount"
                      type="text"
                      inputMode="decimal"
                      placeholder="25,000"
                      value={amount}
                      aria-invalid={amountError ? true : undefined}
                      aria-describedby={amountError ? 'award-amount-error' : 'award-amount-reads'}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  {amountError ? (
                    <p id="award-amount-error" className="error" role="alert">
                      {amountError}
                    </p>
                  ) : (
                    <p id="award-amount-reads" className="meta">
                      {awardCents === null
                        ? '\u00a0'
                        : `Reads as ${formatCents(awardCents, { withCents: true })}`}
                    </p>
                  )}
                  <label className="stack">
                    <span>Announcement date (when they may talk about it)</span>
                    <input
                      id="award-announce"
                      type="date"
                      value={announce}
                      onChange={(e) => setAnnounce(e.target.value)}
                    />
                  </label>
                  <label className="stack">
                    <span>Term start</span>
                    <input
                      id="award-term-start"
                      type="date"
                      value={termStart}
                      onChange={(e) => setTermStart(e.target.value)}
                    />
                  </label>
                  <label className="stack">
                    <span>Term end</span>
                    <input
                      id="award-term-end"
                      type="date"
                      value={termEnd}
                      onChange={(e) => setTermEnd(e.target.value)}
                    />
                  </label>
                  <p className="meta">
                    The award starts as pending: decided, not yet accepted. The W-9 and media
                    release are collected at acceptance, not now.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || awardCents === null || amountError !== null}
                      onClick={() => void createAward()}
                    >
                      Record the award
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="panel-decide">
          {error && (
            <p className="banner danger" role="alert">
              {error}
            </p>
          )}
          {fieldErrors.map((f) => (
            <p key={f.field} className="banner danger" role="alert">
              {f.message}
            </p>
          ))}
          <label className="stack">
            <span>Outcome</span>
            <select
              id="decision-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">Choose…</option>
              <option value="awarded">Awarded</option>
              <option value="declined">Declined</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </label>
          <label className="stack">
            <span>
              Why{status === 'declined' ? ' (required)' : ' (optional)'}
            </span>
            <textarea
              id="decision-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <p className="meta">
            {/* Said before the button, not after. A decline recorded here does
                not reach the applicant, and somebody who assumes otherwise
                leaves 250 nonprofits waiting. */}
            Recording a decision does not create an award or email anybody. Decline letters are
            written and sent separately, after a person has read them.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || status === ''}
              onClick={() => void decide()}
            >
              Record decision
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
