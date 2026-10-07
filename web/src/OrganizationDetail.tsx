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
import { formatDay } from './reportWording';

interface Props {
  organizationId: string;
  onNavigate: (path: string) => void;
}

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
        <h2 tabIndex={-1} data-route-heading>Organization</h2>
        <p className="banner danger" role="alert">{error.message}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        <h2 tabIndex={-1} data-route-heading>Organization</h2>
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const funded = data.awards.length;
  const overdue = data.awards.reduce((n, a) => n + a.reportsOverdue, 0);

  return (
    <>
      <section className="panel">
        {/* Up to the section, not back to the landing page -- see the note
            on the award page's crumbs for why. */}
        <div className="crumbs">
          <button type="button" className="linklike" onClick={() => onNavigate('/organizations')}>
            Organizations
          </button>
          <span aria-hidden="true">/</span>
          <span>{data.legalName}</span>
        </div>

        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>{data.legalName}</h2>
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
        {funded > 0 && data.lastSignInAt === null ? (
          <p role="status" className="empty-reason">
            Nobody at this organization has ever signed in, so no reminder from Steward has been
            shown to reach them — whatever becomes overdue. Somebody has to write to them and ask
            them to claim their grant at the public site.
            {data.hasAccount ? (
              <>
                {' '}
                An account exists for them, but it was created from the grant import rather than
                by anybody here, so it is no evidence the address works.
              </>
            ) : null}
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
            <dt>Last signed in</dt>
            <dd>
              {/*
                NOT "can sign in", which this said and which was false
                comfort: the awards importer creates an account for every
                imported grant, so that read Yes for thirteen nonprofits none
                of whom had ever opened the system.
              */}
              {data.lastSignInAt ? day(data.lastSignInAt) : 'Never'}
            </dd>
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
                  <th scope="col">Program</th>
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
