/**
 * Every grant.
 *
 * WHY THIS DID NOT EXIST. Awards were reachable only through the application
 * that produced them, and since the award page, one at a time by id. "Show me
 * the grants" -- the first thing anybody asks of a grantmaking system -- had
 * no answer at all.
 *
 * TWO COLUMNS CARRY THE SCREEN. Reporting, because the question is never just
 * what was funded but what is still owed; and whether the grantee can sign in,
 * because a grant whose grantee has no account cannot be chased by anything
 * automated, and that was previously visible one nonprofit at a time.
 *
 * THE FILTER STATE IS IN THE URL. An admin who finds the four grants with
 * something outstanding and sends that address to a colleague should send the
 * list, not the screen. It is also what makes the back button work.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AwardListRow, ProgramRow } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  programs: ProgramRow[];
  query: string;
  onQueryChange: (next: string) => void;
  onNavigate: (path: string) => void;
}

const STATUSES = ['pending', 'active', 'closed', 'cancelled'];

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function AwardsList({ programs, query, onQueryChange, onNavigate }: Props): ReactElement {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [rows, setRows] = useState<AwardListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * The search box is local state, committed on submit rather than on every
   * keystroke. Pushing each character into the URL would put forty entries in
   * the back stack for one search and fire forty requests.
   */
  const [search, setSearch] = useState(params.get('q') ?? '');

  useEffect(() => {
    setSearch(params.get('q') ?? '');
  }, [params]);

  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const out = await api.awards(params.toString(), c.signal);
        setRows(out.rows);
        setTotal(out.total);
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [params]);

  function setParam(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    onQueryChange(next.toString());
  }

  const outstanding = params.get('outstanding') === 'true';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Grants</h2>
        <span className="meta">
          {/*
            `total` is the count BEFORE the outstanding filter, which runs
            after the page. Said in words rather than shown as a bare "4 of
            9", which would invite the reader to subtract and get a number
            that means nothing.
          */}
          {loading
            ? 'Loading…'
            : outstanding
              ? `${rows.length} with something outstanding`
              : `${rows.length} of ${total}`}
        </span>
      </div>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', search.trim());
        }}
      >
        <label>
          <span>Search</span>
          <input
            id="awards-search"
            type="search"
            value={search}
            placeholder="Organization, EIN or reference"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          <span>Programme</span>
          <select
            id="awards-program"
            value={params.get('program_id') ?? ''}
            onChange={(e) => setParam('program_id', e.target.value)}
          >
            <option value="">All programmes</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            id="awards-status"
            value={params.get('status') ?? ''}
            onChange={(e) => setParam('status', e.target.value)}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Still owing a report</span>
          <select
            id="awards-outstanding"
            value={outstanding ? 'true' : ''}
            onChange={(e) => setParam('outstanding', e.target.value)}
          >
            <option value="">No</option>
            <option value="true">Yes</option>
          </select>
        </label>
        <button type="submit" className="btn small">
          Search
        </button>
      </form>

      {error ? <p role="alert">{error.message}</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="empty-reason">
          No grants match. Grants arrive here by being imported from a spreadsheet of past awards,
          or by being made from a decided application.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Every grant the Foundation has made</caption>
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Awarded</th>
                <th scope="col">Amount</th>
                <th scope="col">Reporting</th>
                <th scope="col">Grantee</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      type="button"
                      className="rowlink"
                      aria-label={`Open the grant for ${r.organizationName}`}
                      onClick={() => onNavigate(`/awards/${r.id}`)}
                    >
                      {r.organizationName}
                    </button>
                    <span className="meta">{r.programName}</span>
                  </td>
                  <td>
                    {day(r.awardedAt)}
                    <span className="meta">{r.status}</span>
                  </td>
                  <td className="num">{formatCents(r.awardedAmountCents)}</td>
                  <td>
                    {r.reportsTotal === 0 ? (
                      /*
                        "Nothing asked" is the Foundation's omission, not the
                        grantee's. A dash here would read as a clean record.
                      */
                      <span className="meta">Nothing asked yet</span>
                    ) : r.reportsOverdue > 0 ? (
                      <span className="meta strong" data-overdue="true">
                        {r.reportsOverdue} overdue
                      </span>
                    ) : r.reportsOutstanding > 0 ? (
                      <span className="meta">{r.reportsOutstanding} outstanding</span>
                    ) : (
                      <span className="meta">All in</span>
                    )}
                  </td>
                  <td>
                    {r.granteeCanSignIn ? (
                      <span className="meta">Can sign in</span>
                    ) : (
                      /*
                        Marked, because this is the row where no reminder can
                        land. It is not an error -- a grant made last week has
                        not been claimed yet and that is fine -- so it is not
                        red, but it must be findable by eye.
                      */
                      <span className="meta strong">No account yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
