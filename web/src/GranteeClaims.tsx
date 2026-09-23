/**
 * Claims waiting for a person.
 *
 * WHY THIS SCREEN IS THE WHOLE SAFETY MODEL. The public form records a
 * request and grants nothing; approving is what hands somebody access to an
 * organization's grant history. That act lives here, behind Cloudflare
 * Access, admin only, with an audit row — and it is deliberately not
 * one click.
 *
 * THE AWARD ID IS TYPED, NOT PRE-FILLED FROM THE MATCH. The suggestion is
 * shown, with the name it matched, and a button that fills the box — so using
 * it is a decision somebody made rather than a default they scrolled past.
 * matched_award_id comes from an EIN printed on a public tax filing; acting
 * on it automatically would make the guess the decision.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { GranteeClaimRow } from './api';

interface Props {
  isAdmin: boolean;
}

const STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'todo' },
  approved: { label: 'Connected', tone: 'resting' },
  rejected: { label: 'Declined', tone: 'resting' },
};

export function GranteeClaims({ isAdmin }: Props): ReactElement {
  const [claims, setClaims] = useState<GranteeClaimRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The award each pending claim is about to be approved against. */
  const [awardIds, setAwardIds] = useState<Record<string, string>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api.granteeClaims(signal);
      setClaims(res.claims);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof ApiError ? e.message : 'That list could not be loaded.');
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function approve(claim: GranteeClaimRow): Promise<void> {
    const awardId = (awardIds[claim.id] ?? '').trim();
    if (awardId === '') {
      setActionError('Put in the award this claim is for, then approve.');
      return;
    }
    setBusy(claim.id);
    setActionError(null);
    setNotice(null);
    try {
      const out = await api.approveGranteeClaim(claim.id, awardId, null);
      setNotice(
        `${claim.contactEmail} can now sign in.` +
          (out.periodsCreated > 0
            ? ` ${out.periodsCreated} report period${out.periodsCreated === 1 ? '' : 's'} opened.`
            : ' That award has no term dates, so no report period was created — ' +
              'add them on the award if you want one.'),
      );
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That could not be approved.');
    } finally {
      setBusy(null);
    }
  }

  async function decline(claim: GranteeClaimRow): Promise<void> {
    // Asked for here, because the API and the database both require it and a
    // refusal is not the first anybody should hear of that.
    const note = window.prompt(
      `Decline the claim from ${claim.organizationName}? Say why — this is for the next ` +
        'person who reads it, not for them.',
    );
    if (note === null) return;
    setBusy(claim.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.rejectGranteeClaim(claim.id, note);
      // Said plainly, because it is easy to assume otherwise: declining is
      // silent, and somebody still has to tell them.
      setNotice(
        `Declined. No email was sent — ${claim.contactName} has not been told, ` +
          'and somebody should.',
      );
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That could not be declined.');
    } finally {
      setBusy(null);
    }
  }

  const heading = (
    <div className="panel-head">
      <h2 tabIndex={-1} data-route-heading>
        Past grantees
      </h2>
    </div>
  );

  if (error) {
    return (
      <section className="panel">
        {heading}
        <p className="banner danger" role="alert">{error}</p>
      </section>
    );
  }
  if (!claims) {
    return (
      <section className="panel">
        {heading}
        <p className="meta" aria-live="polite">Loading…</p>
      </section>
    );
  }

  const waiting = claims.filter((c) => c.status === 'pending');
  const decided = claims.filter((c) => c.status !== 'pending');

  return (
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          Nonprofits telling us we funded them. Approving one connects that email address to
          an award and lets them sign in and report on it — so check the award is the right
          one before you do.
        </p>
        {actionError && <p className="banner danger" role="alert">{actionError}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}
      </section>

      <section className="panel">
        <h3>Waiting</h3>
        {waiting.length === 0 ? (
          <p className="meta">Nothing is waiting.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Who</th>
                  <th scope="col">The grant, as they describe it</th>
                  <th scope="col">Suggested</th>
                  {isAdmin && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {waiting.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      {c.organizationName}
                      {c.ein && <span className="meta"> · EIN {c.ein}</span>}
                    </th>
                    <td>
                      {c.contactName}
                      <br />
                      <span className="meta">{c.contactEmail}</span>
                      {c.contactJobTitle && <span className="meta"> · {c.contactJobTitle}</span>}
                    </td>
                    <td>
                      {c.grantYear && <strong>{c.grantYear}</strong>}
                      {c.grantDescription && <p className="meta">{c.grantDescription}</p>}
                    </td>
                    <td>
                      {/*
                        A SUGGESTION, shown with what it matched on, and never
                        applied on its own. Filling the box is a click somebody
                        makes.
                      */}
                      {c.matchedAwardId ? (
                        <>
                          <span className="meta">{c.matchedOrganizationName}</span>
                          <br />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() =>
                              setAwardIds((p) => ({ ...p, [c.id]: c.matchedAwardId! }))
                            }
                          >
                            Use {c.matchedAwardLabel}
                          </button>
                        </>
                      ) : (
                        <span className="meta">No match on EIN</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td className="row-actions">
                        <label className="sr-only" htmlFor={`award-${c.id}`}>
                          Award id for {c.organizationName}
                        </label>
                        <input
                          id={`award-${c.id}`}
                          value={awardIds[c.id] ?? ''}
                          placeholder="Award id"
                          onChange={(e) =>
                            setAwardIds((p) => ({ ...p, [c.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy === c.id}
                          onClick={() => void approve(c)}
                        >
                          Connect
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={busy === c.id}
                          onClick={() => void decline(c)}
                        >
                          Decline
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Decided</h3>
        {decided.length === 0 ? (
          <p className="meta">Nothing decided yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Who</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((c) => {
                  const state = STATE[c.status] ?? { label: c.status, tone: 'resting' };
                  return (
                    <tr key={c.id}>
                      <th scope="row">{c.organizationName}</th>
                      <td><span className="meta">{c.contactEmail}</span></td>
                      <td>
                        <span className="portal-chip" data-tone={state.tone}>{state.label}</span>
                      </td>
                      <td className="meta">{c.decisionNote ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
