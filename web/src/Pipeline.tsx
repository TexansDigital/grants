/**
 * The pipeline: every application this staff session may see.
 *
 * The screen a program manager has open all day, so it optimises for density
 * and for answering a question fast, not for looking calm. Filters are in the
 * URL, which is the whole design: "applications over $50,000 in the 2026 cycle
 * that are still under review" is then a link a person can paste into an email,
 * bookmark, or send to a colleague, instead of a sequence of clicks described
 * in prose.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { ApplicationRow, CycleRow, ProgramRow, SearchHit } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  programs: ProgramRow[];
  cycles: CycleRow[];
  /** The query string, owned by the router so it survives a reload and Back. */
  query: string;
  onQueryChange: (next: string) => void;
  onOpen: (applicationId: string) => void;
}

const STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'awarded',
  'declined',
  'withdrawn',
] as const;

/** Money in, money out: the filter is cents, the field is dollars. */
function dollarsToCents(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (!/^\d+$/.test(trimmed.replace(/,/g, ''))) return '';
  return String(Number(trimmed.replace(/,/g, '')) * 100);
}

function centsToDollars(cents: string | null): string {
  if (!cents) return '';
  const n = Number(cents);
  return Number.isSafeInteger(n) ? String(Math.floor(n / 100)) : '';
}

export function Pipeline({ programs, cycles, query, onQueryChange, onOpen }: Props): ReactElement {
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const liveRegion = useRef<HTMLParagraphElement>(null);

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value === '') next.delete(key);
      else next.set(key, value);
      // Any filter change returns to the first page. Staying on page 4 of a
      // result set that now has one page shows an empty table and reads as a
      // bug.
      next.delete('offset');
      onQueryChange(next.toString());
    },
    [onQueryChange, params],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .applications(params.toString(), controller.signal)
      .then((r) => {
        setRows(r.applications);
        setTotal(r.total);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [params]);

  // Announce the result count. A sighted user sees the table change; without
  // this a screen reader user gets no signal that a filter did anything.
  useEffect(() => {
    if (!loading && liveRegion.current) {
      liveRegion.current.textContent = `${total} application${total === 1 ? '' : 's'}`;
    }
  }, [loading, total]);

  const runSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = searchTerm.trim();
      if (q === '') {
        setHits(null);
        return;
      }
      setSearching(true);
      try {
        const { hits: found } = await api.search(q);
        setHits(found);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    },
    [searchTerm],
  );

  const offset = Number(params.get('offset') ?? '0') || 0;
  const limit = Number(params.get('limit') ?? '50') || 50;
  const programId = params.get('program_id') ?? '';
  const visibleCycles = programId ? cycles.filter((c) => c.program_id === programId) : cycles;

  const hitTitles = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return (id: string) => byId.get(id)?.project_title ?? null;
  }, [rows]);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>
            Pipeline
          </h2>
          <span className="meta">
            {loading ? 'Loading…' : `${total} application${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {/* ---- search ------------------------------------------------------ */}
        <form className="searchbar" onSubmit={runSearch} role="search">
          <label htmlFor="fts">Search narratives</label>
          <input
            id="fts"
            type="search"
            value={searchTerm}
            placeholder="youth mental health Fort Bend"
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <button type="submit" className="btn small" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
          {hits !== null && (
            <button
              type="button"
              className="btn small secondary"
              onClick={() => {
                setHits(null);
                setSearchTerm('');
              }}
            >
              Clear
            </button>
          )}
        </form>

        {hits !== null && (
          <div className="hits" aria-live="polite">
            <h3>
              {hits.length} match{hits.length === 1 ? '' : 'es'}
            </h3>
            {hits.length === 0 ? (
              <p className="meta">
                Nothing matched. Search covers narrative answers, organization name and EIN.
              </p>
            ) : (
              <ul>
                {hits.map((h) => (
                  <li key={h.application_id}>
                    <button type="button" className="linklike" onClick={() => onOpen(h.application_id)}>
                      {hitTitles(h.application_id) ?? h.application_id}
                    </button>
                    {/* The snippet carries the FTS delimiters as literal text.
                        It is rendered as text, never as markup. */}
                    <span className="snippet">{h.snippet}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ---- filters ----------------------------------------------------- */}
        <div className="filters">
          <div className="filter">
            <label htmlFor="f-program">Program</label>
            <select
              id="f-program"
              value={programId}
              onChange={(e) => {
                // Changing program invalidates the cycle filter; leaving a stale
                // cycle id selected silently returns nothing.
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('program_id', e.target.value);
                else next.delete('program_id');
                next.delete('cycle_id');
                next.delete('offset');
                onQueryChange(next.toString());
              }}
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
            <label htmlFor="f-cycle">Cycle</label>
            <select
              id="f-cycle"
              value={params.get('cycle_id') ?? ''}
              onChange={(e) => set('cycle_id', e.target.value)}
            >
              <option value="">All cycles</option>
              {visibleCycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="filter">
            <label htmlFor="f-status">Status</label>
            <select
              id="f-status"
              value={params.get('status') ?? ''}
              onChange={(e) => set('status', e.target.value)}
            >
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          <div className="filter">
            <label htmlFor="f-min">Min request ($)</label>
            <input
              id="f-min"
              type="text"
              inputMode="numeric"
              placeholder="5,000"
              defaultValue={centsToDollars(params.get('min_amount_cents'))}
              onBlur={(e) => set('min_amount_cents', dollarsToCents(e.target.value))}
            />
          </div>

          <div className="filter">
            <label htmlFor="f-max">Max request ($)</label>
            <input
              id="f-max"
              type="text"
              inputMode="numeric"
              placeholder="100,000"
              defaultValue={centsToDollars(params.get('max_amount_cents'))}
              onBlur={(e) => set('max_amount_cents', dollarsToCents(e.target.value))}
            />
          </div>

          {params.toString() !== '' && (
            <button type="button" className="btn small secondary" onClick={() => onQueryChange('')}>
              Clear filters
            </button>
          )}
        </div>

        <p className="sr-only" aria-live="polite" ref={liveRegion} />

        {/* ---- results ----------------------------------------------------- */}
        {error ? (
          <p className="error">{error.message}</p>
        ) : rows.length === 0 && !loading ? (
          <p className="meta empty">
            No applications match these filters.
            {params.toString() !== '' && ' Try clearing one of them.'}
          </p>
        ) : (
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Project</th>
                <th scope="col">Cycle</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Requested
                </th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {/* Deliberately no onClick on the <tr>. It bubbled from the
                  button inside it, pushing TWO history entries so one Back
                  appeared to do nothing, and it hijacked drag-selection:
                  highlighting an amount to paste into an email navigated away
                  instead. The button in the first cell is the single
                  affordance, and it is the one a keyboard reaches anyway. */}
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <button type="button" className="linklike" onClick={() => onOpen(r.id)}>
                      {r.organization_name ?? 'Unknown organization'}
                    </button>
                  </th>
                  <td>{r.project_title ?? '—'}</td>
                  <td>{r.cycle_name ?? '—'}</td>
                  <td>
                    <span className={`badge badge-${r.status}`}>{r.status.replace(/_/g, ' ')}</span>
                  </td>
                  <td className="num">
                    {r.requested_amount_cents === null ? '—' : formatCents(r.requested_amount_cents)}
                  </td>
                  <td>{r.submitted_at ? r.submitted_at.slice(0, 10) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {total > limit && (
          <div className="pager">
            <button
              type="button"
              className="btn small secondary"
              disabled={offset === 0}
              onClick={() => set('offset', String(Math.max(offset - limit, 0)))}
            >
              Previous
            </button>
            <span className="meta">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              type="button"
              className="btn small secondary"
              disabled={offset + limit >= total}
              onClick={() => set('offset', String(offset + limit))}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </>
  );
}
