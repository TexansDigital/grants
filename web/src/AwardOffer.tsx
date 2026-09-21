/**
 * "You have been awarded a grant. Do you accept?"
 *
 * WHAT THIS ANSWERS. The award letter tells a grantee to sign in and see what
 * we need from them before funds are released. Until now they signed in and
 * there was nothing to do: no award could move out of `pending`, so no award
 * could ever become active and no reporting schedule could ever exist.
 *
 * ABOVE THE REPORTS, and deliberately. The grantee portal's rule is that the
 * outstanding thing is the first thing on the page with a button on it. An
 * unanswered award is more outstanding than a report that is not due for three
 * months.
 *
 * SAYING NO IS A REAL BUTTON, not a link to an email address. Terms do not
 * always work, a project loses its other funding, an organization folds
 * between the decision and the letter. Making that hard does not make it
 * happen less; it makes it happen silently, and the award sits pending
 * forever.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatCents } from '../../src/lib/money';
import type { PendingAward } from './granteeApi';
import { formatDay } from './reportWording';

/**
 * The words a grantee agrees to, in one place.
 *
 * Sent to the server on acceptance and recorded on the audit row, so "what did
 * they agree to" survives an edit to this constant.
 */
export const ATTESTATION =
  'I am authorised to accept this grant on behalf of my organization, and I agree to ' +
  'the grant term and the reporting dates shown above.';

interface Props {
  awards: PendingAward[];
  onAccept: (awardId: string, attestationText: string) => Promise<void>;
  onDecline: (awardId: string, reason: string) => Promise<void>;
  busy: boolean;
  error: string | null;
}

export function AwardOffer({ awards, onAccept, onDecline, busy, error }: Props): ReactElement | null {
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (awards.length === 0) return null;

  return (
    <section className="portal-todo" aria-labelledby="offer-heading">
      <h3 id="offer-heading">
        {awards.length === 1 ? 'A grant is waiting for your answer' : `${awards.length} grants are waiting for your answer`}
      </h3>

      {error && (
        <p className="banner danger" role="alert">
          {error}
        </p>
      )}

      <ul className="portal-list">
        {awards.map((a) => (
          <li key={a.id}>
            <p className="portal-todo-title">
              {formatCents(a.awardedAmountCents)} — {a.programName}
            </p>
            {a.projectTitle && <p className="portal-meta">{a.projectTitle}</p>}
            {a.termStart && a.termEnd && (
              <p className="portal-meta">
                Grant term: {formatDay(a.termStart)} to {formatDay(a.termEnd)}
              </p>
            )}
            {a.announcementDate && (
              /*
               * The embargo, repeated here and not only in the letter. The
               * letter is read once on a phone; this page is where somebody
               * comes back to check, and "when can we post about it" is the
               * question they come back with.
               */
              <p className="portal-meta">
                Please hold the news until {formatDay(a.announcementDate)}.
              </p>
            )}

            {declining === a.id ? (
              <>
                <label className="stack">
                  <span>What did not work? A sentence is enough.</span>
                  <textarea
                    id={`decline-${a.id}`}
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => {
                      void onDecline(a.id, reason).then(() => {
                        setDeclining(null);
                        setReason('');
                      });
                    }}
                  >
                    Send this
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => {
                      setDeclining(null);
                      setReason('');
                    }}
                  >
                    Back
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="choice attest">
                  <input
                    id={`attest-${a.id}`}
                    type="checkbox"
                    checked={attested[a.id] ?? false}
                    onChange={(e) =>
                      setAttested((prev) => ({ ...prev, [a.id]: e.target.checked }))
                    }
                  />
                  <span>{ATTESTATION}</span>
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !(attested[a.id] ?? false)}
                    onClick={() => void onAccept(a.id, ATTESTATION)}
                  >
                    Accept this grant
                  </button>
                  {/*
                    * Plain and secondary, not hidden behind a link. Saying no
                    * is a legitimate answer, and a grantee who cannot find how
                    * to give it simply never answers.
                    */}
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => setDeclining(a.id)}
                  >
                    We cannot accept
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
