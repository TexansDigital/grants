/**
 * What was agreed, what has gone out, and the gap.
 *
 * STEWARD DOES NOT PAY ANYBODY, and the screen says so. CLAUDE.md: "The system
 * does not disburse money. It records schedules and status. Disbursement stays
 * with finance." A screen with a button reading "Pay" would be a lie about
 * what this system does; the button reads "Record as paid", because what an
 * admin is doing is writing down somebody else's fact.
 *
 * THE REFERENCE IS REQUIRED for the same reason. When a grantee says the money
 * never arrived, this screen is what gets opened, and a "paid" with nothing to
 * look it up by cannot help.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AwardLedger } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  awardId: string;
}

/** Dollars in, cents on the wire. Rounded, never truncated. */
function toCents(dollars: string): number {
  return Math.round(Number(dollars.replace(/[$,\s]/g, '')) * 100);
}

export function PaymentLedger({ awardId }: Props): ReactElement | null {
  const [ledger, setLedger] = useState<AwardLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLedger(await api.payments(awardId, signal));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // A reviewer reaching this component at all would be a routing bug,
        // and the API answers 404. Render nothing rather than an error that
        // says a ledger exists.
        setLedger(null);
      }
    },
    [awardId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ledger) return null;

  return (
    <section className="panel">
      <h3>Payments</h3>
      <p className="meta">
        {/* Said on the screen, not only in a comment. Somebody reading a
            "paid" date needs to know where it came from. */}
        Steward records the schedule and what finance reports as paid. It does not move money.
      </p>

      {error && (
        <p className="banner danger" role="alert">
          {error}
        </p>
      )}

      <p>
        <strong>{formatCents(ledger.paidCents)}</strong> paid of{' '}
        {formatCents(ledger.scheduledCents)} scheduled, against an award of{' '}
        {formatCents(ledger.awardedAmountCents)}.
        {ledger.unscheduledCents > 0 && (
          <span className="meta"> {formatCents(ledger.unscheduledCents)} not yet scheduled.</span>
        )}
      </p>

      {ledger.payments.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Due</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Reference</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.payments.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{new Date(p.scheduledDate).toLocaleDateString('en-US')}</th>
                  <td className="num">{formatCents(p.amountCents)}</td>
                  <td>
                    {p.status}
                    {p.paidDate && (
                      <span className="meta">
                        {' '}
                        {new Date(p.paidDate).toLocaleDateString('en-US')}
                      </span>
                    )}
                    {p.status === 'cancelled' && p.note && (
                      // A cancelled payment keeps its reason on screen. "We
                      // promised this and then did not" is the question this
                      // row exists to answer.
                      <span className="meta"> — {p.note}</span>
                    )}
                  </td>
                  <td>{p.referenceNumber ?? '—'}</td>
                  <td className="actions">
                    {p.status === 'scheduled' && (
                      <>
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={busy}
                          onClick={() => {
                            const reference = window.prompt(
                              'Cheque number or transfer reference:',
                            );
                            if (!reference) return;
                            void run(() =>
                              api.recordPayment(p.id, {
                                paidDate: new Date().toISOString(),
                                referenceNumber: reference,
                              }),
                            );
                          }}
                        >
                          Record as paid
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={busy}
                          onClick={() => {
                            const reason = window.prompt('Why is this payment not happening?');
                            if (!reason) return;
                            void run(() => api.cancelPayment(p.id, reason));
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ledger.unscheduledCents > 0 && (
        <div className="panel-decide">
          <label className="stack">
            <span>Amount</span>
            <input
              id="payment-amount"
              type="text"
              inputMode="decimal"
              placeholder="8,333.33"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Due</span>
            <input
              id="payment-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || amount.trim() === '' || due === ''}
              onClick={() =>
                void run(async () => {
                  await api.schedulePayment(awardId, {
                    amountCents: toCents(amount),
                    scheduledDate: new Date(`${due}T12:00:00Z`).toISOString(),
                  });
                  setAmount('');
                  setDue('');
                })
              }
            >
              Schedule a payment
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
