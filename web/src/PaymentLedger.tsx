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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AwardLedger } from './api';
import { formatCents, parseCurrencyToCents, MoneyParseError } from '../../src/lib/money';

interface Props {
  awardId: string;
}

/*
 * NO LOCAL toCents HERE ANY MORE.
 *
 * This file used to define `Math.round(Number(dollars) * 100)`, which is the
 * exact thing money.ts's own header forbids: "never `parseFloat(x) * 100`,
 * which turns 25000.07 into 2500006.9999999995". It is a CLAUDE.md
 * non-negotiable and I wrote it anyway, on a payment amount.
 *
 * `parseCurrencyToCents` does it with string arithmetic, refuses more than two
 * decimal places, refuses negatives and non-numeric text, and enforces
 * MAX_CENTS -- none of which the local version did. It is the same function
 * the applicant's own currency field uses, which is the point: an admin
 * typing an award amount should get at least what an applicant gets.
 */

export function PaymentLedger({ awardId }: Props): ReactElement | null {
  const [ledger, setLedger] = useState<AwardLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  /** Which payment is being recorded or cancelled, and the fields for it. */
  const [recording, setRecording] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  /*
   * WHERE THE KEYBOARD GOES WHEN A FORM OPENS.
   *
   * Pressing "Record as paid" renders a form BELOW the table and left focus on
   * the button. A sighted user sees the form appear; somebody on a keyboard or
   * a screen reader gets no announcement and no movement, and has to tab past
   * every remaining row to reach the fields that just appeared. Moving focus
   * to the form's heading puts them at the top of what they asked for and
   * reads the heading, which names the payment and the amount.
   */
  const recordHeading = useRef<HTMLHeadingElement>(null);
  const cancelHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (recording) recordHeading.current?.focus();
  }, [recording]);
  useEffect(() => {
    if (cancelling) cancelHeading.current?.focus();
  }, [cancelling]);

  /*
   * Parse as they type, so the confirmation line and the error are both live.
   * `cents` is null while the box is empty or unparseable, which is also what
   * disables the button -- one source of truth rather than a separate
   * validity flag that can disagree with what is shown.
   */
  let cents: number | null = null;
  let amountError: string | null = null;
  if (amount.trim() !== '') {
    try {
      cents = parseCurrencyToCents(amount);
    } catch (e) {
      amountError = e instanceof MoneyParseError ? e.message : 'That is not an amount.';
    }
  }
  if (cents !== null && ledger && cents > ledger.unscheduledCents) {
    // Caught server-side too. Said here so somebody is not told after typing
    // a date and pressing a button.
    amountError = `Only ${formatCents(ledger.unscheduledCents)} of this award is unscheduled.`;
  }

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

  const recordingRow = ledger.payments.find((p) => p.id === recording) ?? null;
  const cancellingRow = ledger.payments.find((p) => p.id === cancelling) ?? null;

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
                    <span className={`badge badge-${p.status}`}>{p.status}</span>
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
                  <td className="row-actions">
                    {p.status === 'scheduled' && (
                      <>
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={busy}
                          onClick={() => setRecording(recording === p.id ? null : p.id)}
                        >
                          Record as paid
                          <span className="sr-only">
                            {' '}
                            &mdash; {formatCents(p.amountCents)} due{' '}
                            {new Date(p.scheduledDate).toLocaleDateString('en-US')}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={busy}
                          onClick={() => setCancelling(cancelling === p.id ? null : p.id)}
                        >
                          Cancel this payment
                          <span className="sr-only">
                            {' '}
                            &mdash; {formatCents(p.amountCents)} due{' '}
                            {new Date(p.scheduledDate).toLocaleDateString('en-US')}
                          </span>
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

      {recordingRow && (
        /*
         * AN INLINE FORM, NOT A PROMPT. This writes a record the schema will
         * not let anybody change afterwards, and the prompt it replaces named
         * no payment and hard-coded the paid date to TODAY. If finance paid on
         * the 3rd and an admin recorded it on the 10th, the ledger permanently
         * said the 10th -- on the one field that answers "when did the money
         * go out", with no correction path.
         */
        <div className="panel-decide">
          <h3 tabIndex={-1} ref={recordHeading}>
            Record {formatCents(recordingRow.amountCents)} as paid
          </h3>
          <p className="meta">
            Due {new Date(recordingRow.scheduledDate).toLocaleDateString('en-US')} to{' '}
            {ledger.organizationName}. This cannot be changed afterwards; a correction is a new
            payment.
          </p>
          <label className="stack">
            <span>Date paid</span>
            <input
              id="paid-date"
              type="date"
              value={paidDate}
              onChange={(e) => setPaidDate(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Cheque number or transfer reference</span>
            <input
              id="paid-reference"
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || reference.trim() === '' || paidDate === ''}
              onClick={() =>
                void run(async () => {
                  await api.recordPayment(recordingRow.id, {
                    paidDate: new Date(`${paidDate}T12:00:00Z`).toISOString(),
                    referenceNumber: reference.trim(),
                  });
                  setRecording(null);
                  setReference('');
                })
              }
            >
              Record {formatCents(recordingRow.amountCents)} as paid
            </button>
            <button type="button" className="btn secondary" onClick={() => setRecording(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {cancellingRow && (
        <div className="panel-decide">
          <h3 tabIndex={-1} ref={cancelHeading}>
            Cancel {formatCents(cancellingRow.amountCents)}
          </h3>
          <p className="meta">
            Due {new Date(cancellingRow.scheduledDate).toLocaleDateString('en-US')}. The payment
            stays on the record with your reason, and the amount becomes available to schedule
            again.
          </p>
          <label className="stack">
            <span>Why is this payment not happening?</span>
            <textarea
              id="cancel-reason"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || cancelReason.trim().length < 3}
              onClick={() =>
                void run(async () => {
                  await api.cancelPayment(cancellingRow.id, cancelReason.trim());
                  setCancelling(null);
                  setCancelReason('');
                })
              }
            >
              Cancel this payment
            </button>
            <button type="button" className="btn secondary" onClick={() => setCancelling(null)}>
              Back
            </button>
          </div>
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
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? 'payment-amount-error' : 'payment-amount-reads'}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {amountError ? (
            <p id="payment-amount-error" className="error" role="alert">
              {amountError}
            </p>
          ) : (
            /*
             * "Reads as $8,333.33", the same confirmation the applicant's own
             * currency field gives. Somebody typing an award payment deserves
             * at least what an applicant gets.
             */
            <p id="payment-amount-reads" className="meta">
              {cents === null ? '\u00a0' : `Reads as ${formatCents(cents, { withCents: true })}`}
            </p>
          )}
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
              disabled={busy || cents === null || amountError !== null || due === ''}
              onClick={() =>
                void run(async () => {
                  await api.schedulePayment(awardId, {
                    amountCents: cents!,
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
