/**
 * Who the Foundation has funded.
 *
 * A PUBLIC, LIGHT-THEMED, READ-ONLY PAGE, on the applicant surface. Most
 * funders publish this; it costs no extra data entry because every field is
 * already recorded for another reason, and it partly serves the external
 * reporting that is manual today.
 *
 * WHAT IS NOT HERE. No contact names, no EINs, no narrative, no scores, no
 * decision rationale. An organization that applied for a grant did not consent
 * to its application being published, and the parts that are public are the
 * parts a funder publishes: who, for what, how much.
 *
 * GROUPED BY YEAR, and no search box. Twenty-five to a hundred awards a year
 * across a handful of years is a page somebody reads or uses their browser's
 * own find on. A search field would be a control to learn in order to do what
 * ctrl-F already does, and a paginated list would be three clicks to discover
 * that a grant is not listed.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { formatCents } from '../../src/lib/money';

export interface PublicGrant {
  organizationName: string;
  programName: string;
  fiscalYear: number | null;
  projectTitle: string | null;
  awardedAmountCents: number;
  awardedYear: string;
}

export function PublicGrants(): ReactElement {
  const [grants, setGrants] = useState<PublicGrant[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/public/grants', {
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { grants: PublicGrant[] };
      setGrants(body.grants);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  const years = [...new Set((grants ?? []).map((g) => g.awardedYear))];
  const total = (grants ?? []).reduce((t, g) => t + g.awardedAmountCents, 0);

  return (
    <>
      <div className="section-head">
        <h2 tabIndex={-1} data-route-heading>
          Grants we have made
        </h2>
        <p>
          Organizations the Houston Texans Foundation has funded, and what for.
        </p>
      </div>

      {failed && (
        <div className="card portal-empty">
          <h3>This list could not be loaded</h3>
          <p>Please try again in a moment.</p>
        </div>
      )}

      {grants === null && !failed && (
        <p className="portal-meta" aria-live="polite">
          Loading…
        </p>
      )}

      {grants !== null && grants.length === 0 && (
        <div className="card portal-empty">
          <h3>Nothing is published yet</h3>
          <p>
            {/*
              * Honest about which it is. "No grants" would be untrue -- the
              * Foundation makes them -- and a nonprofit reading that would
              * draw the wrong conclusion about whether to apply.
              */}
            Grants are listed here once they have been announced. Nothing is listed at the
            moment.
          </p>
        </div>
      )}

      {grants !== null && grants.length > 0 && (
        <>
          <p className="portal-meta">
            {grants.length} grant{grants.length === 1 ? '' : 's'}, totalling{' '}
            {formatCents(total)}.
          </p>

          {years.map((year) => (
            <section className="card portal-award" key={year} aria-labelledby={`year-${year}`}>
              <div className="portal-award-head">
                <h3 id={`year-${year}`}>{year}</h3>
              </div>
              <ul className="portal-list">
                {grants
                  .filter((g) => g.awardedYear === year)
                  .map((g, i) => (
                    <li key={`${year}-${i}-${g.organizationName}`}>
                      <p className="portal-todo-title">{g.organizationName}</p>
                      {g.projectTitle && <p className="portal-meta">{g.projectTitle}</p>}
                      <p className="portal-meta">
                        {g.programName} &middot; {formatCents(g.awardedAmountCents)}
                      </p>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}
