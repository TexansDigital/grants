/**
 * Changing an award, and the record of every change.
 *
 * WHY THIS SCREEN EXISTS. Migration 0012 has refused to let an awarded amount
 * be updated since Phase 0 -- "an awarded amount changes through an amendment,
 * not an update" -- pointing at an amendments table that Phase 4 never built.
 * So an award recorded at the wrong amount could not be corrected through this
 * system in any way, and the documented remedy amounted to somebody editing
 * the production database by hand.
 *
 * THE HISTORY IS THE PRODUCT, not the form. "$25,000, amended to $18,000 on 14
 * March because the partner site withdrew" is a sentence a program officer
 * quotes back to a grantee, and it is what the grant IS. So the history is
 * shown whether or not anybody is amending anything, and it is never collapsed
 * behind a disclosure.
 *
 * OPTIMISTIC LOCKING, which CLAUDE.md names as a known gap: "Two admins on one
 * award produces last-write-wins unless optimistic locking is built
 * deliberately." The `updatedAt` this screen loaded travels back with the
 * change; if somebody else moved the award in between, the API refuses and
 * says so rather than quietly discarding their work.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AmendmentRow, AwardPaperwork } from './api';
import { formatCents, parseCurrencyToCents, MoneyParseError } from '../../src/lib/money';

interface Props {
  awardId: string;
  /** The award as this screen last read it. Carries the concurrency token. */
  award: AwardPaperwork;
  /** Re-read the award after a change, so the token is fresh. */
  onAmended: () => void;
}

const FIELD_LABEL: Record<AmendmentRow['fieldChanged'], string> = {
  awarded_amount_cents: 'Amount',
  term_start: 'Term start',
  term_end: 'Term end',
  announcement_date: 'Announcement date',
};

/** An ISO timestamp as the value a date input wants, or ''. */
const asDay = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

/** The stored value, shown the way a person reads that field. */
function showValue(row: AmendmentRow, value: string | null): string {
  if (value === null || value === '') return 'not set';
  if (row.fieldChanged === 'awarded_amount_cents') {
    const cents = Number(value);
    return Number.isSafeInteger(cents) && cents >= 0 ? formatCents(cents) : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString('en-US') : value;
}

export function AwardAmendments({ awardId, award, onAmended }: Props): ReactElement {
  const [history, setHistory] = useState<AmendmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const [amount, setAmount] = useState('');
  const [termStart, setTermStart] = useState('');
  const [termEnd, setTermEnd] = useState('');
  const [announce, setAnnounce] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setHistory((await api.amendments(awardId, signal)).amendments);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setHistory([]);
      }
    },
    [awardId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  /** Fill the form from the award as it stands, so nothing reads as a change. */
  function start(): void {
    setAmount(String(award.awardedAmountCents / 100));
    setTermStart(asDay(award.termStart));
    setTermEnd(asDay(award.termEnd));
    setAnnounce(asDay(award.announcementDate));
    setReason('');
    setError(null);
    setNotice(null);
    setOpen(true);
  }

  /*
   * NOT `Number(x) * 100`. money.ts's header forbids it by name -- it turns
   * 25000.07 into 2500006.9999999995 -- and this is an award amount.
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

  /** Only the fields that actually differ, so nothing is amended by accident. */
  function changes(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (cents !== null && cents !== award.awardedAmountCents) out.awardedAmountCents = cents;
    const dates: [string, string, string | null][] = [
      ['termStart', termStart, award.termStart],
      ['termEnd', termEnd, award.termEnd],
      ['announcementDate', announce, award.announcementDate],
    ];
    for (const [key, typed, current] of dates) {
      const next = typed === '' ? null : new Date(`${typed}T12:00:00Z`).toISOString();
      if (asDay(next) !== asDay(current)) out[key] = next;
    }
    return out;
  }

  const pending = open ? changes() : {};
  const nothingToDo = Object.keys(pending).length === 0;

  async function amend(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.amendAward(awardId, {
        ...pending,
        reason: reason.trim(),
        // The token this screen loaded. If the award moved underneath it, the
        // API refuses rather than discarding somebody else's change.
        expectedUpdatedAt: award.updatedAt,
      });
      setNotice(
        `Amended: ${result.changed.map((f) => FIELD_LABEL[f as AmendmentRow['fieldChanged']] ?? f).join(', ')}.`,
      );
      setOpen(false);
      await load();
      onAmended();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Amendments</h3>
        {award.status !== 'cancelled' && !open && (
          <button type="button" className="btn secondary" disabled={busy} onClick={start}>
            Amend this award
          </button>
        )}
      </div>

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

      {award.status === 'cancelled' && (
        <p className="meta">
          This award was cancelled, so there is nothing to amend. Its history is below.
        </p>
      )}

      {history === null ? (
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      ) : history.length === 0 ? (
        <p className="meta">
          {formatCents(award.awardedAmountCents)}, unchanged since it was recorded.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Why, and who</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <th scope="row">{new Date(h.amendedAt).toLocaleDateString('en-US')}</th>
                  <td>{FIELD_LABEL[h.fieldChanged] ?? h.fieldChanged}</td>
                  <td>{showValue(h, h.oldValue)}</td>
                  <td>
                    <strong>{showValue(h, h.newValue)}</strong>
                  </td>
                  <td>
                    {h.reason}
                    <span className="meta"> — {h.amendedBy}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="panel-decide">
          <h3 tabIndex={-1} ref={(el) => el?.focus()}>
            Amend this award
          </h3>
          <p className="meta">
            {/*
              Said before, not after. An amendment is a permanent record with
              the amending admin's name on it, and the number it changes is one
              a grantee has already been told.
            */}
            Currently {formatCents(award.awardedAmountCents)} to {award.organizationName}. Every
            field you change is recorded separately, with your reason and your name, and cannot
            be edited afterwards.
          </p>

          <label className="stack">
            <span>Amount</span>
            <input
              id="amend-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? 'amend-amount-error' : 'amend-amount-reads'}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {amountError ? (
            <p id="amend-amount-error" className="error" role="alert">
              {amountError}
            </p>
          ) : (
            <p id="amend-amount-reads" className="meta">
              {cents === null
                ? ' '
                : cents === award.awardedAmountCents
                  ? 'Unchanged.'
                  : `Reads as ${formatCents(cents, { withCents: true })}`}
            </p>
          )}

          <label className="stack">
            <span>Term start</span>
            <input
              id="amend-term-start"
              type="date"
              value={termStart}
              onChange={(e) => setTermStart(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Term end</span>
            <input
              id="amend-term-end"
              type="date"
              value={termEnd}
              onChange={(e) => setTermEnd(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Announcement date</span>
            <input
              id="amend-announce"
              type="date"
              value={announce}
              onChange={(e) => setAnnounce(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Why is this award changing?</span>
            <textarea
              id="amend-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {nothingToDo && (
            <p className="meta" aria-live="polite">
              Nothing on this award would change yet.
            </p>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || nothingToDo || reason.trim().length < 3 || amountError !== null}
              onClick={() => void amend()}
            >
              Record this amendment
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
