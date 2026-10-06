/**
 * Every nonprofit the Foundation has a record of.
 *
 * THE REASON TO OPEN THIS SCREEN is usually not browsing. It is "which of our
 * grantees cannot be reached by anything this system sends" -- a question
 * nothing in the platform has ever answered in one place, and the one that
 * decides whether the thirteen file their updates. The detail page answers it
 * for one nonprofit at a time, which is no use for finding the ones nobody has
 * thought about.
 *
 * So that filter is not buried among the others. It is the first control, and
 * it is phrased as the question rather than as a field name.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { OrganizationListRow } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  query: string;
  onQueryChange: (next: string) => void;
  onNavigate: (path: string) => void;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

function formatEin(ein: string | null): string {
  if (!ein) return '—';
  return /^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
}

export function OrganizationsList({ query, onQueryChange, onNavigate }: Props): ReactElement {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [rows, setRows] = useState<OrganizationListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(params.get('q') ?? '');

  useEffect(() => {
    setSearch(params.get('q') ?? '');
  }, [params]);

  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const out = await api.organizations(params.toString(), c.signal);
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

  const unreachable = params.get('unreachable') === 'true';
  const fundedOnly = params.get('funded') === 'true';
  const filtered = unreachable || fundedOnly;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Organizations</h2>
        <span className="meta">
          {loading ? 'Loading…' : filtered ? `${rows.length} shown` : `${rows.length} of ${total}`}
        </span>
      </div>

      {/*
        FIRST, and worded as the question. Everything else on this screen is a
        way of browsing; this is the one that finds a problem nobody would
        otherwise look for.
      */}
      <p className="filter-lead">
        <button
          type="button"
          className="btn small"
          aria-pressed={unreachable}
          onClick={() => setParam('unreachable', unreachable ? '' : 'true')}
        >
          {unreachable ? 'Showing grantees we cannot reach' : 'Which grantees can we not reach?'}
        </button>
        <span className="meta">
          Funded nonprofits where nobody can sign in. No reminder from Steward reaches them —
          somebody has to write.
        </span>
      </p>

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
            id="orgs-search"
            type="search"
            value={search}
            placeholder="Name or EIN"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          <span>Funded only</span>
          <select
            id="orgs-funded"
            value={fundedOnly ? 'true' : ''}
            onChange={(e) => setParam('funded', e.target.value)}
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
          {unreachable
            ? 'Every funded nonprofit has somebody who can sign in. Nothing to chase.'
            : 'No organizations match.'}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Nonprofits the Foundation has a record of</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">EIN</th>
                <th scope="col">Grants</th>
                <th scope="col">Total awarded</th>
                <th scope="col">Last grant</th>
                <th scope="col">Can sign in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      type="button"
                      className="rowlink"
                      aria-label={`Open ${r.legalName}`}
                      onClick={() => onNavigate(`/organizations/${r.id}`)}
                    >
                      {r.legalName}
                    </button>
                    {r.reportsOverdue > 0 ? (
                      <span className="meta strong" data-overdue="true">
                        {r.reportsOverdue} report{r.reportsOverdue === 1 ? '' : 's'} overdue
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {formatEin(r.ein)}
                    {r.ein && !r.einVerifiedAt ? <span className="meta">unverified</span> : null}
                  </td>
                  <td className="num">{r.grants}</td>
                  <td className="num">
                    {/*
                      Zero rather than a blank. An empty cell in a money column
                      reads as missing data; a nonprofit that has applied and
                      never been funded has a total, and it is nothing.
                    */}
                    {formatCents(r.totalAwardedCents)}
                  </td>
                  <td>{day(r.lastAwardedAt)}</td>
                  <td>
                    {r.canSignIn ? (
                      <span className="meta">Yes</span>
                    ) : r.grants > 0 ? (
                      <span className="meta strong">No — nothing can reach them</span>
                    ) : (
                      <span className="meta">No</span>
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
