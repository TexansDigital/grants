/**
 * The week the decisions go out.
 *
 * FIFTY ACCEPTANCES AND 250 DECLINES, in the same few days. CLAUDE.md calls
 * this the highest-reputation-risk output in the system and it is right: the
 * decline is what gets screenshotted and forwarded, and the award carries an
 * amount to a named organization.
 *
 * THE SCREEN IS SHAPED BY THE ORDER OF THAT WEEK. Awards are a block, worked
 * first. Declines are a block below it, visibly locked until the awards block
 * is empty, with the reason said in words rather than a greyed-out button
 * nobody can account for.
 *
 * THERE IS NO STANDARD DECLINE WORDING HERE, and the box is empty on purpose.
 * The Foundation has not settled what these letters should say, and a default
 * that shipped would be this system putting words in its mouth to 250
 * nonprofits. Whoever sends it writes it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { CommunicationQueue, PendingRow, DeclineBatchResult } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  cycleId: string;
  onBack: () => void;
}

export function Communications({ cycleId, onBack }: Props): ReactElement {
  const [queue, setQueue] = useState<CommunicationQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The decline letter currently being written, keyed by application. */
  const [writing, setWriting] = useState<string | null>(null);
  const [letter, setLetter] = useState('');
  /** The shared letter, for everyone who is getting the same one. */
  const [batchLetter, setBatchLetter] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ sent: number; remaining: number } | null>(
    null,
  );
  const [batchFailures, setBatchFailures] = useState<DeclineBatchResult['outcomes']>([]);

  /*
   * Send the shared letter, a round at a time, until nothing is left.
   *
   * THE LOOP IS HERE AND NOT ON THE SERVER, deliberately. A Worker request
   * attempting 250 mail-provider calls is betting the batch on a subrequest
   * limit, and the failure mode is a request that dies at letter 180 with
   * nobody able to say which 180. Rounds are small, every letter is keyed on
   * its own application so nothing sends twice, and the person watching sees a
   * number move rather than a spinner.
   *
   * FAILURES ACCUMULATE RATHER THAN STOPPING IT. A bad address on one
   * application must not hold up the others, and the list names who missed out
   * so somebody can act on it now rather than reading a reply in three weeks.
   */
  async function sendAllDeclines(): Promise<void> {
    const paragraphs = batchLetter
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) {
      setError('Write the letter before sending it.');
      return;
    }
    if (
      !window.confirm(
        `This sends the same letter to ${queue?.declines.length ?? 0} organizations. ` +
          'It cannot be unsent. Send it?',
      )
    ) {
      return;
    }

    setBatchRunning(true);
    setError(null);
    setNotice(null);
    setBatchFailures([]);
    let sent = 0;
    try {
      // A hard ceiling on rounds as well as on the loop condition: a server
      // that kept reporting work left would otherwise spin here forever.
      for (let round = 0; round < 200; round += 1) {
        const result = await api.notifyDeclineBatch(cycleId, paragraphs);
        sent += result.sent;
        setBatchProgress({ sent, remaining: result.remaining });
        setBatchFailures((prev) => [...prev, ...result.outcomes.filter((o) => !o.ok)]);
        // Stop when nothing is left, and ALSO when a round achieved nothing --
        // otherwise a batch where every remaining letter fails loops forever.
        if (result.remaining === 0 || result.sent === 0) break;
      }
      setNotice(`Sent ${sent} letter${sent === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBatchRunning(false);
    }
  }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setQueue(await api.communications(cycleId, signal));
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [cycleId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function act(id: string, fn: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function sendDecline(row: PendingRow): Promise<void> {
    const paragraphs = letter
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) {
      setError('Write the letter before sending it.');
      return;
    }
    await act(
      row.applicationId,
      () => api.notifyDecline(row.applicationId, paragraphs),
      `Sent to ${row.organizationName}.`,
    );
    setWriting(null);
    setLetter('');
  }

  async function markManual(row: PendingRow): Promise<void> {
    const note = window.prompt(`How was ${row.organizationName} told?`);
    if (!note) return;
    await act(
      row.applicationId,
      () => api.markCommunicated(row.applicationId, note),
      `Recorded for ${row.organizationName}.`,
    );
  }

  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        Decision letters
      </h2>
      <button type="button" className="btn secondary small" onClick={onBack}>
        Back to configuration
      </button>
    </div>
  );

  if (!queue) {
    return (
      <section className="panel">
        {heading}
        {error ? (
          <p className="banner danger" role="alert">
            {error}
          </p>
        ) : (
          <p className="meta" aria-live="polite">
            Loading…
          </p>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          {queue.programName} &middot; {queue.cycleName}. Nothing here has been sent
          automatically, and nothing will be. Until an applicant is told, their own portal shows
          the application as still under review.
        </p>
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
      </section>

      <section className="panel">
        <h3>Awards to send ({queue.awards.length})</h3>
        {queue.awards.length === 0 ? (
          <p className="meta">
            {queue.awardsCommunicated > 0
              ? `All ${queue.awardsCommunicated} award letters have gone out.`
              : 'No awards are waiting to be sent.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Embargo</th>
                  <th scope="col">
                    <span className="sr-only">Send</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.awards.map((r) => (
                  <tr key={r.applicationId}>
                    <th scope="row">{r.organizationName}</th>
                    <td className="num">
                      {r.awardedAmountCents === null ? (
                        // The letter carries the amount, so it cannot go until
                        // somebody has created the award record.
                        <span className="meta">no award record yet</span>
                      ) : (
                        formatCents(r.awardedAmountCents)
                      )}
                    </td>
                    <td>
                      {r.announcementDate
                        ? new Date(r.announcementDate).toLocaleDateString('en-US')
                        : '—'}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy === r.applicationId || r.awardedAmountCents === null}
                        onClick={() =>
                          void act(
                            r.applicationId,
                            () => api.notifyAward(r.applicationId),
                            `Sent to ${r.organizationName}.`,
                          )
                        }
                      >
                        Send award letter
                      </button>
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={busy === r.applicationId}
                        onClick={() => void markManual(r)}
                      >
                        Told another way
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Declines to send ({queue.declines.length})</h3>
        {!queue.declinesUnlocked && (
          <p className="banner danger" role="alert">
            {/* The reason, in words. A greyed-out button nobody can account for
                is how somebody works around a rule they do not understand. */}
            {queue.awards.length} award letter{queue.awards.length === 1 ? '' : 's'} in this cycle
            have not gone out yet. Acceptances go first &mdash; an applicant who hears no on
            Monday and sees a peer announce on Tuesday has been told twice.
          </p>
        )}
        {queue.declines.length === 0 ? (
          <p className="meta">No declines are waiting to be sent.</p>
        ) : (
          <>
            {queue.declinesUnlocked && queue.declines.length > 1 && (
              <article className="review-section">
                <h3>Send the same letter to all {queue.declines.length}</h3>
                <p className="meta">
                  Most declines say the same thing. Write it once. Anyone who needs different
                  words can be sent theirs individually below &mdash; do that first, and they
                  will not appear in this count.
                </p>
                <label className="stack">
                  <span>The letter</span>
                  <textarea
                    id="batch-letter"
                    rows={8}
                    value={batchLetter}
                    placeholder="Blank lines separate paragraphs."
                    onChange={(e) => setBatchLetter(e.target.value)}
                  />
                </label>
                {batchProgress && (
                  <p className="banner" role="status" aria-live="polite">
                    Sent {batchProgress.sent}. {batchProgress.remaining} to go.
                  </p>
                )}
                {batchFailures.length > 0 && (
                  <>
                    <p className="banner danger" role="alert">
                      {batchFailures.length} could not be sent. The rest went.
                    </p>
                    <ul className="answers">
                      {batchFailures.map((f) => (
                        <li key={f.applicationId}>
                          {f.organizationName}: {f.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={batchRunning || batchLetter.trim() === ''}
                    onClick={() => void sendAllDeclines()}
                  >
                    {batchRunning ? 'Sending…' : `Send to all ${queue.declines.length}`}
                  </button>
                </div>
              </article>
            )}

            {queue.declines.map((r) => (
            <article key={r.applicationId} className="review-section">
              <h3>{r.organizationName}</h3>
              <p className="meta">
                {r.projectTitle ?? 'Untitled application'} &middot; {r.contactEmail ?? 'no address'}
              </p>
              {writing === r.applicationId ? (
                <>
                  <label className="stack">
                    <span>The letter</span>
                    <textarea
                      id={`letter-${r.applicationId}`}
                      rows={8}
                      value={letter}
                      placeholder="Blank lines separate paragraphs."
                      onChange={(e) => setLetter(e.target.value)}
                    />
                  </label>
                  <p className="meta">
                    There is no standard wording in this system, on purpose. Reviewer scores and
                    the internal rationale are never included &mdash; only what you write here.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === r.applicationId || !queue.declinesUnlocked}
                      onClick={() => void sendDecline(r)}
                    >
                      Send this letter
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        setWriting(null);
                        setLetter('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={!queue.declinesUnlocked}
                    onClick={() => {
                      setWriting(r.applicationId);
                      setLetter('');
                    }}
                  >
                    Write the letter
                    <span className="sr-only"> for {r.organizationName}</span>
                  </button>
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={busy === r.applicationId || !queue.declinesUnlocked}
                    onClick={() => void markManual(r)}
                  >
                    Told another way
                  </button>
                </div>
              )}
            </article>
          ))}
          </>
        )}
      </section>
    </>
  );
}
