/**
 * What is about to be destroyed, and what already was.
 *
 * WHY THIS SCREEN EXISTS. Retention runs on a cron at one in the morning and
 * destroys files without asking. Everything that happens without asking needs
 * somewhere a person can go and see it happening -- before, so they can hold
 * one back, and after, so they can answer "what happened to the budget we had
 * from them in March".
 *
 * THE PAST TENSE IS NOT HIDDEN. A retention screen that shows only what is
 * upcoming looks tidier and cannot answer the only question anyone will ever
 * bring to it. What was destroyed stays listed, with the date.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { RetentionScreen } from './api';

interface Props {
  isAdmin: boolean;
}

/** The soonest a hold is worth setting. Shorter than this, use the date field. */
const HOLD_DAYS = 90;

function daysUntil(iso: string): number {
  return Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
}

export function Retention({ isAdmin }: Props): ReactElement {
  const [data, setData] = useState<RetentionScreen | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await api.retention(signal));
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function download(id: string): Promise<void> {
    setBusy(id);
    setNotice(null);
    try {
      const grant = await api.downloadUrl(id);
      window.location.assign(grant.url);
      // The list changes as a result: asking for a file is what takes it off
      // the nightly notice, so the screen should stop showing it as unread.
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'That file could not be opened.');
    } finally {
      setBusy(null);
    }
  }

  async function hold(id: string, filename: string): Promise<void> {
    // A reason is required by the API and by the database. Asking for it here
    // means the refusal is not the first the person hears of it.
    const reason = window.prompt(`Why is ${filename} being kept longer?`);
    if (reason === null) return;
    setBusy(id);
    setNotice(null);
    try {
      const until = new Date(Date.now() + HOLD_DAYS * 86_400_000).toISOString();
      await api.holdAttachment(id, until, reason);
      setNotice(`${filename} will be kept for another ${HOLD_DAYS} days.`);
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'That file could not be held.');
    } finally {
      setBusy(null);
    }
  }

  async function purge(id: string, filename: string): Promise<void> {
    const reason = window.prompt(
      `Delete ${filename} now? This destroys the file permanently. Say why:`,
    );
    if (reason === null) return;
    setBusy(id);
    setNotice(null);
    try {
      await api.purgeAttachment(id, reason);
      setNotice(`${filename} has been deleted.`);
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'That file could not be deleted.');
    } finally {
      setBusy(null);
    }
  }

  // `data-route-heading` and tabIndex match every other staff screen: the app
  // moves focus here on navigation, so a keyboard or screen-reader user lands
  // on the page title rather than at the top of the chrome.
  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        Retention
      </h2>
    </div>
  );

  if (error) {
    return (
      <section className="panel">
        {heading}
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        {heading}
        <p className="meta" aria-live="polite">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          Applicants&rsquo; uploaded financial documents are destroyed on a schedule after their
          application is decided. An application with a pending or active award is not on a clock
          at all &mdash; the itemized budget is what the award was made against.
        </p>
        {notice && (
          <p className="banner" role="status">
            {notice}
          </p>
        )}
      </section>

      <section className="panel">
        <h3>Due within 30 days</h3>
        {data.upcoming.length === 0 ? (
          <p className="meta">Nothing is due to be destroyed in the next 30 days.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">File</th>
                  <th scope="col">Deletes</th>
                  <th scope="col">Asked for</th>
                  {isAdmin && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.upcoming.map((f) => {
                  const days = daysUntil(f.effective_due_at);
                  return (
                    <tr key={f.id}>
                      <th scope="row">{f.organization_name}</th>
                      <td>{f.filename}</td>
                      <td>
                        {days <= 0 ? 'Tonight' : `in ${days} day${days === 1 ? '' : 's'}`}
                      </td>
                      <td>
                        {/*
                         * "Asked for", not "downloaded". Downloads go from the
                         * browser straight to R2, so this system knows a link
                         * was issued and cannot know the bytes arrived. Saying
                         * "downloaded" would tell somebody deciding whether to
                         * let a financial statement be destroyed something the
                         * system does not know.
                         */}
                        {f.download_url_first_issued_at ? 'Yes' : <strong>No</strong>}
                      </td>
                      {isAdmin && (
                        <td className="actions">
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={busy === f.id}
                            onClick={() => void download(f.id)}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={busy === f.id}
                            onClick={() => void hold(f.id, f.filename)}
                          >
                            Keep longer
                          </button>
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={busy === f.id}
                            onClick={() => void purge(f.id, f.filename)}
                          >
                            Delete now
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Already destroyed</h3>
        <p className="meta">
          The files are gone. The record of what was uploaded, by whom, and when it was destroyed
          is kept, because that is a financial record.
        </p>
        {data.purged.length === 0 ? (
          <p className="meta">Nothing has been destroyed yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">File</th>
                  <th scope="col">Destroyed</th>
                </tr>
              </thead>
              <tbody>
                {data.purged.map((f) => (
                  <tr key={String(f.id)}>
                    <th scope="row">{String(f.organization_name ?? '')}</th>
                    <td>{String(f.filename ?? '')}</td>
                    <td>{new Date(String(f.purged_at)).toLocaleDateString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
