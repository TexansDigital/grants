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
 *
 * WHY WAITING IS CARDS AND DECIDED IS A TABLE. This used to be one table for
 * both, and a foundation manager seeing it for the first time read it as data
 * rather than as a question being asked of them. A table is for comparing
 * rows; nobody compares claims. Each one is a separate judgement — is this
 * really them, and which grant do they mean — made once and not revisited. So
 * Waiting states the question in words and walks one claim at a time, and
 * Decided stays a table, because looking back over what was granted IS a scan.
 *
 * Every piece of copy here answers something somebody actually got stuck on:
 * what an EIN match was for, why Connect was greyed out, what the search box
 * searches, and that declining sends nobody anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { GranteeClaimRow, AwardChoice } from './api';
import { InfoTip } from './InfoTip';
import { formatCents } from '../../src/lib/money';

interface Props {
  isAdmin: boolean;
}

const STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'todo' },
  approved: { label: 'Connected', tone: 'resting' },
  rejected: { label: 'Declined', tone: 'resting' },
};

/** Said the same way in three places, so it is written once. */
const EIN_EXPLAINER = (
  <>
    An Employer Identification Number: the nine-digit number the IRS gives a
    nonprofit. It identifies the <em>organization</em>, never a particular
    grant — so a match tells you who they are, not which award they mean.
  </>
);

export function GranteeClaims({ isAdmin }: Props): ReactElement {
  const [claims, setClaims] = useState<GranteeClaimRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The award each pending claim is about to be approved against. */
  const [chosen, setChosen] = useState<Record<string, AwardChoice>>({});
  /** Which claim's picker is open, the text in it, and what came back. */
  const [picking, setPicking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<AwardChoice[] | null>(null);
  const [searching, setSearching] = useState(false);

  /*
   * Searched on a keystroke, debounced, and the LAST response wins.
   *
   * Without the sequence guard a slow search for "bay" can land after a fast
   * one for "bayou reach" and replace a precise list with a stale broad one --
   * on the screen where the next click connects somebody to a grant.
   */
  const seq = useRef(0);
  useEffect(() => {
    if (picking === null) return undefined;
    const q = query.trim();
    if (q === '') {
      setFound(null);
      return undefined;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      void api
        .searchAwards(q)
        .then((r) => {
          if (mine === seq.current) setFound(r.awards);
        })
        .catch(() => {
          if (mine === seq.current) setFound([]);
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query, picking]);

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
    const award = chosen[claim.id];
    if (!award) {
      setActionError('Choose the award this claim is for, then connect.');
      return;
    }
    const awardId = award.id;
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

  /** One claim, as the decision it is. */
  function claimCard(c: GranteeClaimRow): ReactElement {
    const pick = chosen[c.id];
    const isPicking = picking === c.id;

    return (
      <article className="claim" data-claim key={c.id}>
        {/* 1. WHO IS ASKING, in their own words. */}
        <header className="claim-head">
          <h4>{c.organizationName}</h4>
          <p className="meta">
            {c.contactName} · {c.contactEmail}
            {c.contactJobTitle && ` · ${c.contactJobTitle}`}
          </p>
          <p className="claim-says">
            Says we funded them
            {c.grantYear ? ` in ${c.grantYear}` : ''}
            {c.grantDescription ? `: “${c.grantDescription}”` : '.'}
          </p>
          <p className="meta">
            {c.ein ? `EIN ${c.ein}` : 'They gave no EIN'}{' '}
            <InfoTip label="EIN">{EIN_EXPLAINER}</InfoTip>
          </p>
        </header>

        {/* 2. THE QUESTION, asked out loud. */}
        <div className="claim-step">
          {pick ? (
            <>
              <h5>You are about to connect them to</h5>
              <p className="claim-award">
                <strong>{pick.organizationName}</strong>
                <br />
                {pick.programName} {pick.awardedYear} ·{' '}
                {formatCents(pick.awardedAmountCents)}
              </p>
              {pick.alreadyHeldBy && (
                <p className="claim-note">
                  Somebody already has access to this award: {pick.alreadyHeldBy}. Two
                  people from one nonprofit is ordinary — this is only worth a look.
                </p>
              )}
              {isAdmin && (
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => {
                    setChosen((p) => {
                      const next = { ...p };
                      delete next[c.id];
                      return next;
                    });
                    setPicking(c.id);
                    setQuery('');
                  }}
                >
                  Change
                </button>
              )}
            </>
          ) : (
            <>
              <h5>Which award is this?</h5>
              {/*
                THE EIN RESULT IN PLAIN WORDS. "No match on EIN" stated the
                outcome of a process nobody had seen, did not say whether it
                was bad, and did not say what to do next.
              */}
              <p className="meta">
                {c.matchedOrganizationName
                  ? `Their EIN matches awards for ${c.matchedOrganizationName}. An EIN ` +
                    'identifies the organization, not the grant, so check which award ' +
                    'they mean.'
                  : 'We compared their EIN against the awards on file and nothing ' +
                    'matched. That is common and not a problem — nonprofits often give ' +
                    'a slightly different number, or none. Search for the award yourself.'}
              </p>

              {isPicking ? (
                <>
                  <label className="sr-only" htmlFor={`find-${c.id}`}>
                    Find the award for {c.organizationName}
                  </label>
                  <input
                    id={`find-${c.id}`}
                    value={query}
                    autoFocus
                    placeholder="Organization name or EIN"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {/*
                    THE SENTENCE THAT WOULD HAVE SAVED THE FIRST REAL USER.
                    The box is seeded with what the CLAIMANT wrote, which reads
                    as "this is the thing being searched for" -- and it usually
                    is not what the award is filed under.
                  */}
                  <p className="field-hint">
                    This searches the organization name <em>on the award</em>, or its
                    EIN — not what they wrote above. One distinctive word finds more
                    than the full legal name.
                  </p>
                  {searching && <p className="meta">Searching…</p>}
                  {found !== null && found.length === 0 && !searching && (
                    <p className="meta">
                      Nothing matches. If this grant predates the system, it has to be
                      imported before anyone can be connected to it.
                    </p>
                  )}
                  {found && found.length > 0 && (
                    <p className="field-hint">Choose the award this claim is for:</p>
                  )}
                  {found?.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="btn secondary small"
                      onClick={() => {
                        setChosen((p) => ({ ...p, [c.id]: a }));
                        setPicking(null);
                        setQuery('');
                        setFound(null);
                      }}
                    >
                      {a.organizationName} · {a.programName} {a.awardedYear} ·{' '}
                      {formatCents(a.awardedAmountCents)}
                      {a.ein ? ` · EIN ${a.ein}` : ''}
                    </button>
                  ))}
                </>
              ) : (
                isAdmin && (
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() => {
                      setPicking(c.id);
                      setQuery(c.ein ?? c.organizationName);
                    }}
                  >
                    Find the award
                  </button>
                )
              )}
            </>
          )}
        </div>

        {/* 3. THE DECISION, with the consequence stated where it is taken. */}
        {isAdmin && (
          <footer className="claim-actions">
            <p className="claim-consequence" id={`consequence-${c.id}`}>
              {pick ? (
                <>
                  <strong>{c.contactEmail}</strong> will be able to sign in and see this
                  grant and its reports. There is no way to undo this here.
                </>
              ) : (
                'Choose an award above, and Connect will become available.'
              )}
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="btn small"
                disabled={busy === c.id || !pick}
                aria-describedby={`consequence-${c.id}`}
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
            </div>
          </footer>
        )}
      </article>
    );
  }

  return (
    <>
      <section className="panel">
        {heading}
        <p className="meta">
          Nonprofits telling us we funded them, asking to report on it. For each one:
          find the award they mean, then <strong>connect them to it</strong> — or{' '}
          <strong>decline</strong>.
        </p>
        {/* Underneath, not inside the sentence: an explanation that opens in
            flow would otherwise split that sentence around itself. */}
        <p className="infotip-row">
          <InfoTip label="connecting somebody" trigger="What happens when I connect somebody?">
            Connecting links that email address to one award. They can then sign in and
            see that grant and its reports — and nothing belonging to any other
            organization. It cannot be undone from this screen, so check the award first.
          </InfoTip>
          <InfoTip label="declining a claim" trigger="What happens when I decline?">
            Declining records a reason for whoever reads this next. It sends them
            nothing, on purpose: “we have no record of funding you” should come from a
            person who can answer the next question. Somebody still has to tell them.
          </InfoTip>
        </p>
        {actionError && <p className="banner danger" role="alert">{actionError}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}
      </section>

      <section className="panel" aria-labelledby="waiting-heading">
        <h3 id="waiting-heading">
          Waiting{waiting.length > 0 && <span className="count"> · {waiting.length}</span>}
        </h3>
        {waiting.length === 0 ? (
          <p className="meta">Nothing is waiting.</p>
        ) : (
          <div className="claims">{waiting.map(claimCard)}</div>
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
                  {/* Named at length on purpose: this is the claimant's own
                      wording, and the next column is what it resolved to. */}
                  <th scope="col">Organization, as they wrote it</th>
                  <th scope="col">Who</th>
                  <th scope="col">Outcome</th>
                  {/*
                    WHAT THE ACCESS ACTUALLY WENT TO. The organization column is
                    what the CLAIMANT typed, which is right for the record and
                    no use at all for "who did we let in" -- the two differ
                    exactly when somebody should be looking.
                  */}
                  <th scope="col">Connected to</th>
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
                      <td>
                        {c.grantedOrganizationName ? (
                          <>
                            {c.grantedOrganizationName}
                            <br />
                            <span className="meta">{c.grantedAwardLabel}</span>
                          </>
                        ) : (
                          <span className="meta">Nothing — no access was given</span>
                        )}
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
