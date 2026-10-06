/**
 * One nonprofit, and everything the Foundation knows about them.
 *
 * WHAT THIS REPLACES. CLAUDE.md says the institutional memory -- "this org
 * has applied three times, was funded once for $25,000, filed both reports on
 * time" -- currently lives in one person's head. This is where it lives
 * instead. It is also the only screen that can answer the question the
 * Foundation is actually blocked on this month: has anybody at this nonprofit
 * got a login, and if not, nothing automated will ever reach them.
 *
 * THAT ANSWER IS AT THE TOP, NOT BURIED IN THE CONTACTS TABLE. A grantee with
 * no account is invisible to every reminder in the system, and the failure
 * mode is silent: the report goes overdue, the nightly job finds nobody to
 * email, and the desk shows a red row that nobody caused. So it is a banner,
 * phrased as what somebody has to do rather than as a status.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { OrganizationOverview } from './api';
import { formatCents } from '../../src/lib/money';

interface Props {
  organizationId: string;
  onNavigate: (path: string) => void;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** An EIN as it is printed on a Form 990. Stored as nine digits. */
function formatEin(ein: string | null): string {
  if (!ein) return '—';
  return /^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
}

export function OrganizationDetail({ organizationId, onNavigate }: Props): ReactElement {
  const [data, setData] = useState<OrganizationOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      try {
        setData(await api.organization(organizationId, c.signal));
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      }
    })();
    return () => c.abort();
  }, [organizationId]);

  if (error) {
    return (
      <section className="panel">
        <h2>Organization</h2>
        <p role="alert">{error.message}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        <h2>Organization</h2>
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const funded = data.awards.length;
  const overdue = data.awards.reduce((n, a) => n + a.reportsOverdue, 0);

  return (
    <>
      <section className="panel">
        <div className="crumbs">
          <button type="button" className="linklike" onClick={() => onNavigate('/to-do')}>
            To do
          </button>
          <span aria-hidden="true">/</span>
          <span>Organization</span>
        </div>

        <div className="panel-head">
          <h2>{data.legalName}</h2>
          <span className={`badge badge-${data.status}`}>{data.status}</span>
        </div>

        {/*
          A MERGED RECORD SAYS SO FIRST. Everything below it is the history of
          a record that is no longer the live one, and somebody who reads the
          grants without reading this would draw conclusions from a duplicate.
        */}
        {data.mergedIntoId ? (
          <p role="status" className="empty-reason">
            This record was merged into <strong>{data.mergedIntoName}</strong>. What follows is
            kept for the audit trail; the live record is the other one.{' '}
            <button
              type="button"
              className="linklike"
              onClick={() => onNavigate(`/organizations/${data.mergedIntoId}`)}
            >
              Open it
            </button>
          </p>
        ) : null}

        {/*
          THE BLOCKING QUESTION, ABOVE THE FACTS. Only shown when they have a
          grant: "nobody can sign in" is a problem for a grantee who owes a
          report and merely a fact for an organization that has only ever
          applied.
        */}
        {funded > 0 && !data.canSignIn ? (
          <p role="status" className="empty-reason">
            Nobody at this organization can sign in yet, so no reminder from Steward can reach
            them — whatever becomes overdue. Somebody has to write to them and ask them to claim
            their grant at the public site.
          </p>
        ) : null}

        <dl className="facts">
          <div>
            <dt>EIN</dt>
            <dd>
              {formatEin(data.ein)}
              {data.ein && !data.einVerifiedAt ? (
                <span className="badge">Unverified</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Total awarded</dt>
            <dd>{formatCents(data.totalAwardedCents)}</dd>
          </div>
          <div>
            <dt>Grants</dt>
            <dd>{funded}</dd>
          </div>
          <div>
            <dt>Applications</dt>
            <dd>{data.applications.length}</dd>
          </div>
          <div>
            <dt>Reports overdue</dt>
            <dd>{overdue === 0 ? 'None' : <strong>{overdue}</strong>}</dd>
          </div>
          <div>
            <dt>Annual budget</dt>
            <dd>
              {data.annualOperatingBudgetCents === null
                ? '—'
                : formatCents(data.annualOperatingBudgetCents)}
            </dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>
              {data.website ? (
                /*
                 * noreferrer as well as noopener: this is a URL a stranger
                 * typed into a public form, and the referrer would otherwise
                 * tell their site which internal page it was clicked from.
                 */
                <a href={data.website} target="_blank" rel="noopener noreferrer">
                  {data.website.replace(/^https?:\/\//, '')}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Can sign in</dt>
            <dd>{data.canSignIn ? 'Yes' : 'No'}</dd>
          </div>
        </dl>

        {data.mission ? (
          <>
            <h3 className="after-facts">Mission</h3>
            <p>{data.mission}</p>
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Grants</h2>
          {funded > 0 ? <span className="count">{funded}</span> : null}
        </div>
        {funded === 0 ? (
          <p className="empty-reason">
            This organization has never been funded. If they have applied, their applications are
            below.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Every grant made to this organization</caption>
              <thead>
                <tr>
                  <th scope="col">Awarded</th>
                  <th scope="col">Programme</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reporting</th>
                </tr>
              </thead>
              <tbody>
                {data.awards.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        type="button"
                        className="rowlink"
                        aria-label={`Open the grant awarded ${day(a.awardedAt)}`}
                        onClick={() => onNavigate(`/awards/${a.id}`)}
                      >
                        {day(a.awardedAt)}
                      </button>
                      <span className="meta">{a.status}</span>
                    </td>
                    <td>{a.programName}</td>
                    <td className="num">{formatCents(a.awardedAmountCents)}</td>
                    <td>
                      {/*
                        "Nothing asked" is not the same as "nothing owed", and
                        it is the Foundation's own omission rather than the
                        grantee's. Said in those words, because a dash here
                        would read as a clean record.
                      */}
                      {a.reportsTotal === 0 ? (
                        <span className="meta">Nothing asked yet</span>
                      ) : a.reportsOverdue > 0 ? (
                        <span className="meta strong" data-overdue="true">
                          {a.reportsOverdue} overdue
                        </span>
                      ) : a.reportsOutstanding > 0 ? (
                        <span className="meta">{a.reportsOutstanding} outstanding</span>
                      ) : (
                        <span className="meta">
                          {a.reportsAccepted} of {a.reportsTotal} accepted
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Applications</h2>
          {data.applications.length > 0 ? (
            <span className="count">{data.applications.length}</span>
          ) : null}
        </div>
        {data.applications.length === 0 ? (
          <p className="empty-reason">
            No applications. Every grant made before Steward existed was imported from a
            spreadsheet and has none, so this is expected for past grantees.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Applications from this organization</caption>
              <thead>
                <tr>
                  <th scope="col">Submitted</th>
                  <th scope="col">Project</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        type="button"
                        className="rowlink"
                        aria-label={`Open the application ${a.projectTitle ?? day(a.submittedAt)}`}
                        onClick={() => onNavigate(`/applications/${a.id}`)}
                      >
                        {day(a.submittedAt)}
                      </button>
                    </td>
                    <td>{a.projectTitle ?? '—'}</td>
                    <td>{a.cycleName ?? '—'}</td>
                    <td>
                      <span className={`badge badge-${a.status}`}>{a.status}</span>
                    </td>
                    <td className="num">
                      {a.requestedAmountCents === null ? '—' : formatCents(a.requestedAmountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>People</h2>
          {data.contacts.length > 0 ? <span className="count">{data.contacts.length}</span> : null}
        </div>
        {data.contacts.length === 0 ? (
          <p className="empty-reason">
            No contacts recorded. Imported grants carry no contact details; a name and address
            arrive when somebody claims the grant.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">People at this organization</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Account</th>
                </tr>
              </thead>
              <tbody>
                {data.contacts.map((c) => (
                  <tr key={c.email}>
                    <td>
                      {c.name}
                      {c.isPrimary ? <span className="badge">Primary</span> : null}
                    </td>
                    <td>{c.email}</td>
                    <td>{c.jobTitle ?? '—'}</td>
                    <td>
                      {c.hasAccount ? (
                        <>
                          Yes
                          <span className="meta">
                            {c.lastLoginAt ? `last in ${day(c.lastLoginAt)}` : 'never signed in'}
                          </span>
                        </>
                      ) : (
                        <span className="meta">No</span>
                      )}
                    </td>
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
