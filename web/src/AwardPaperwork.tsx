/**
 * What is still outstanding on one award.
 *
 * WHY IT SITS ABOVE THE PAYMENT LEDGER. CLAUDE.md puts the W-9 and the media
 * release at award acceptance rather than at application -- "collecting tax
 * documents from 300 applicants to fund 50 is waste and unnecessary custody of
 * sensitive documents" -- and the columns for all three have existed since
 * 0012. Nothing could write them. The data health screen has been checking
 * active awards for a missing W-9 against columns no screen could fill.
 *
 * A DATE, NOT A FILE. These arrive by email today and an admin is confirming
 * receipt; "received on the 12th" is honest about that. Attaching the document
 * itself is the next step -- `attachments.parent_type` already admits 'award'
 * -- and is a stated gap rather than something half-built here.
 *
 * IT ENFORCES NOTHING. Scheduling a payment on an award with no W-9 is not
 * refused, because Steward does not disburse money and the Foundation's own
 * order of operations is its to run. What this does is say so, next to the
 * schedule, where somebody about to record a payment will read it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AwardPaperwork as Paperwork } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  awardId: string;
}

/** Today, as the value a date input wants. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AwardPaperwork({ awardId }: Props): ReactElement | null {
  const [data, setData] = useState<Paperwork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which document is being recorded, and the date typed for it. */
  const [recording, setRecording] = useState<string | null>(null);
  const [when, setWhen] = useState(today());

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setData(await api.awardPaperwork(awardId, signal));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // A reviewer reaching this component would be a routing bug, and the
        // API answers 404. Render nothing rather than an error implying the
        // award exists.
        setData(null);
      }
    },
    [awardId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function run(fn: () => Promise<unknown>, said: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(said);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  const row = data.documents.find((d) => d.key === recording) ?? null;

  return (
    <section className="panel">
      <h3>Before funds are released</h3>

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

      {data.declinedByGranteeAt ? (
        <p className="banner danger" role="alert">
          {data.organizationName} did not accept this award
          {data.granteeResponseNote ? `: ${data.granteeResponseNote}` : '.'}
        </p>
      ) : data.acceptedAt ? (
        <p className="meta">
          Accepted {new Date(data.acceptedAt).toLocaleDateString('en-US')}.
          {data.granteeResponseNote ? ` They said: ${data.granteeResponseNote}` : ''}
        </p>
      ) : (
        <p className="banner">
          {data.organizationName} has not accepted this award yet. Nothing below is due from
          them until they do.
        </p>
      )}

      {/*
        The sentence somebody recording a payment needs to read, and the one
        nothing could say before: money is scheduled against an award whose
        paperwork is not in. Not a refusal -- a fact, beside the schedule.
      */}
      {data.outstanding > 0 && data.scheduledCents > 0 && !data.declinedByGranteeAt && (
        <p className="banner danger" role="alert">
          {formatCents(data.scheduledCents)} is scheduled against this award and{' '}
          {data.outstanding} document{data.outstanding === 1 ? ' is' : 's are'} still
          outstanding.
        </p>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Received</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.documents.map((d) => (
              <tr key={d.key}>
                <th scope="row">{d.label}</th>
                <td>
                  {d.receivedAt ? (
                    new Date(d.receivedAt).toLocaleDateString('en-US')
                  ) : (
                    <strong data-overdue="true">Not yet</strong>
                  )}
                </td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={busy}
                    onClick={() => {
                      setRecording(recording === d.key ? null : d.key);
                      setWhen(d.receivedAt ? d.receivedAt.slice(0, 10) : today());
                    }}
                  >
                    {d.receivedAt ? 'Change the date' : 'Record receipt'}
                    <span className="sr-only"> of the {d.label}</span>
                  </button>
                  {d.receivedAt && (
                    <button
                      type="button"
                      className="btn secondary small"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.recordAwardDocument(awardId, d.key, null),
                          `${d.label} is no longer recorded as received.`,
                        )
                      }
                    >
                      Clear
                      <span className="sr-only"> the {d.label} date</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {row && (
        <div className="panel-decide">
          <h3 tabIndex={-1} ref={(el) => el?.focus()}>
            When did the {row.label} arrive?
          </h3>
          <p className="meta">
            {/*
              The date the document arrived, not the date somebody got round to
              typing it in. The same correction the payment ledger learned: a
              field hard-coded to today is permanently wrong for anything
              recorded late, on the column that answers "when did we have it".
            */}
            The date it arrived, which is not always today. This is a record of receipt, not a
            copy of the document.
          </p>
          <label className="stack">
            <span>Date received</span>
            <input
              id="document-date"
              type="date"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || when === ''}
              onClick={() =>
                void run(async () => {
                  await api.recordAwardDocument(
                    awardId,
                    row.key,
                    new Date(`${when}T12:00:00Z`).toISOString(),
                  );
                  setRecording(null);
                }, `${row.label} recorded as received.`)
              }
            >
              Record it
            </button>
            <button type="button" className="btn secondary" onClick={() => setRecording(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
