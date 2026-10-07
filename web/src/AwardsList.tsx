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
import { formatDay } from './reportWording';

interface Props {
  programs: ProgramRow[];
  query: string;
  onQueryChange: (next: string) => void;
  onNavigate: (path: string) => void;
}

/*
 * The award status values as the DATABASE defines them. 0012 constrains the
 * column to exactly these four, and this list must match it character for
 * character or an option silently returns nothing.
 *
 * It said 'closed' at first, which is not a status this system has, so that
 * option matched zero rows -- while omitting 'completed', which is what every
 * imported 2025 grant actually is. A dropdown whose option returns nothing is
 * worse than no dropdown: it reads as "we have none of those".
 *
 * The double-l in 'cancelled' is the schema's spelling, not prose, and must
 * not be Americanized along with the interface copy.
 */
const STATUSES = ['pending', 'active', 'completed', 'cancelled'] as const;

/*
 * What each status is called on screen. The compliance desk keeps the same
 * kind of map ("submitted" becomes "Filed, awaiting us") precisely so raw
 * column values never reach a reader; this screen printed them lowercase.
 */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Offered',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/*
 * The house date helper, not a local slice.
 *
 * These four screens each kept a private `iso.slice(0, 10)`, so the
 * compliance desk said a report was due "December 31, 2025" and the award
 * page for the same grant said "2025-12-31" -- one person moving between them
 * all day, looking at two products. formatDay also pins the rendering to UTC,
 * for the reason its own docblock gives: a calendar date rendered in Central
 * lands on the previous day, and a grant running to 31 December displayed as
 * ending the 30th.
 */
function day(iso: string | null): string {
  return formatDay(iso) || '—';
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
        <h2 tabIndex={-1} data-route-heading>Grants</h2>
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

      {/*
        The house pattern: each control wrapped in `.filter`, with a real
        <label htmlFor> above it. This screen first used a bare <label> with
        the text inside, which matched no CSS rule at all -- so every caption
        sat jammed against its dropdown. Pipeline and the compliance desk have
        done it this way since they were written.
      */}
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', search.trim());
        }}
      >
        <div className="filter">
          <label htmlFor="awards-search">Search</label>
          <input
            id="awards-search"
            type="search"
            value={search}
            placeholder="Organization, EIN or reference"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter">
          <label htmlFor="awards-program">Program</label>
          <select
            id="awards-program"
            value={params.get('program_id') ?? ''}
            onChange={(e) => setParam('program_id', e.target.value)}
          >
            <option value="">All programs</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter">
          <label htmlFor="awards-status">Status</label>
          <select
            id="awards-status"
            value={params.get('status') ?? ''}
            onChange={(e) => setParam('status', e.target.value)}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </div>
        <div className="filter">
          <label htmlFor="awards-outstanding">Still owing a report</label>
          <select
            id="awards-outstanding"
            value={outstanding ? 'true' : ''}
            onChange={(e) => setParam('outstanding', e.target.value)}
          >
            <option value="">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
        <button type="submit" className="btn small">
          Search
        </button>
      </form>

      {error ? <p className="banner danger" role="alert">{error.message}</p> : null}

      {/*
        `!error` IS LOAD-BEARING. `rows` is still [] after a failed first
        load, so without it the empty state renders alongside the error --
        and on Organizations with the filter on, a 500 produced "Every funded
        nonprofit has somebody who has signed in. Nothing to chase.", a green
        light generated by a request that never answered. Reports.tsx has
        guarded this since it was written.
      */}
      {!loading && !error && rows.length === 0 ? (
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
                <th scope="col">Grantee signed in</th>
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
                    <span className="meta">{STATUS_LABEL[r.status] ?? r.status}</span>
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
                      /*
                        "Nothing outstanding", not "All in" -- idiom, and
                        wrong besides: this branch also covers a report that
                        was WAIVED rather than received, and the organization
                        page words the same state as "n of m accepted". Two
                        screens describing one grant differently.
                      */
                      <span className="meta">Nothing outstanding</span>
                    )}
                  </td>
                  <td>
                    {r.granteeLastSignInAt ? (
                      <span className="meta">{day(r.granteeLastSignInAt)}</span>
                    ) : (
                      /*
                        Marked, because this is the row where no reminder has
                        ever been shown to land. Not an error -- a grant made
                        last week has not been claimed yet and that is fine --
                        so not red, but it must be findable by eye.

                        "Never" rather than "no account": the awards importer
                        creates an account for every imported grant, so an
                        account existing proves nothing. A sign-in does.
                      */
                      <span className="meta strong">Never</span>
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
