/**
 * Putting two records of one nonprofit back together.
 *
 * The screen is built around one decision an admin has to get right: WHICH
 * record survives. So it shows what each one actually holds -- applications,
 * awards, contacts, reports still owed -- side by side, rather than asking
 * them to pick between two names.
 *
 * NOTHING MERGES WITHOUT A PREVIEW. The plan says exactly what would move and
 * names every conflict; merging is the second press. Re-pointing rows is not
 * reversible in any way that matters, and a confirm dialog is not a substitute
 * for showing somebody the consequence first.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { DuplicateGroup, MergePlan, OrganizationSummary } from './api';
import { formatDay } from './reportWording';

interface Props {
  isAdmin: boolean;
}

export function Duplicates({ isAdmin }: Props): ReactElement {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .duplicates(controller.signal)
      .then((out) => setGroups(out.groups))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="panel" aria-labelledby="duplicates-heading">
      <div className="panel-head">
        <h2 id="duplicates-heading">
          Possible duplicate organizations
        </h2>
        <p className="meta" aria-live="polite">
          {groups === null
            ? 'Loading…'
            : groups.length === 0
              ? 'None found'
              : `${groups.length} to look at`}
        </p>
      </div>

      <p className="meta">
        Two records of one nonprofit are expected — an EIN typed with a dash one year and
        without it the next, or a second contact applying under their own name. Merging
        reunites a grantee with the grants and reports they already hold.
      </p>

      {error && (
        <p className="banner danger" role="alert">
          {error.message}
        </p>
      )}

      {groups?.length === 0 && (
        <p className="empty">No records look like the same organization twice.</p>
      )}

      {groups?.map((g) => (
        <DuplicateGroupPanel
          key={`${g.reason}:${g.key}`}
          group={g}
          isAdmin={isAdmin}
          onMerged={() => setReloadKey((n) => n + 1)}
        />
      ))}
    </section>
  );
}

function DuplicateGroupPanel({
  group,
  isAdmin,
  onMerged,
}: {
  group: DuplicateGroup;
  isAdmin: boolean;
  onMerged: () => void;
}): ReactElement {
  const [survivorId, setSurvivorId] = useState<string>(
    // Default to the record with the most on it. It is the likelier survivor,
    // and defaulting to "the first one" quietly makes creation order the
    // decision.
    () => [...group.organizations].sort((a, b) => weight(b) - weight(a))[0]!.id,
  );
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const duplicates = group.organizations.filter((o) => o.id !== survivorId);

  const preview = useCallback(
    async (duplicateId: string) => {
      setState({ kind: 'working' });
      try {
        setPlan(await api.mergePreview(duplicateId, survivorId));
        setState({ kind: 'idle' });
      } catch (e) {
        setPlan(null);
        setState({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'Could not work that out. Try again.',
        });
      }
    },
    [survivorId],
  );

  const merge = useCallback(async () => {
    if (!plan) return;
    const ok = window.confirm(
      `Merge "${plan.merged.legalName}" into "${plan.survivor.legalName}"? ` +
        'This re-points their applications, awards and contacts and cannot be undone.',
    );
    if (!ok) return;
    setState({ kind: 'working' });
    try {
      await api.merge(plan.merged.id, plan.survivor.id);
      setPlan(null);
      setState({ kind: 'idle' });
      onMerged();
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'That did not go through. Try again.',
      });
    }
  }, [onMerged, plan]);

  return (
    <article className="review-section">
      <div className="review-head">
        {/*
          Every name, not the first one. Titling the group after
          organizations[0] put a heading over the table naming a record the
          screen had already defaulted to NOT keeping -- which reads as a
          decision that has been made, above the control that makes it.
        */}
        <h3>
          {group.reason === 'same_ein'
            ? `EIN ${group.key}`
            : group.organizations.map((o) => o.legalName).join(' · ')}
        </h3>
        <span className="meta">
          {group.reason === 'same_ein' ? 'Same EIN' : 'Similar name'}
        </span>
      </div>

      <div className="table-scroll">
        <table>
          <caption className="sr-only">Records that may be the same organization</caption>
          <thead>
            <tr>
              <th scope="col">Keep</th>
              <th scope="col">Organization</th>
              <th scope="col">EIN</th>
              <th scope="col" className="num">Applications</th>
              <th scope="col" className="num">Awards</th>
              <th scope="col" className="num">Reports owed</th>
              <th scope="col">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {group.organizations.map((o) => (
              <tr key={o.id}>
                <td>
                  {/*
                    A bare radio with a visually hidden label, NOT the .choice
                    card the applicant form uses. That class paints its checked
                    state #f2f9fd -- a hard-coded light blue that does not move
                    with the theme, so on the dark internal ground it would be a
                    white box in the middle of a dark table.
                  */}
                  <label>
                    <input
                      type="radio"
                      name={`survivor-${group.reason}-${group.key}`}
                      checked={survivorId === o.id}
                      onChange={() => {
                        setSurvivorId(o.id);
                        // A plan built against the other survivor is now
                        // describing a merge nobody asked for.
                        setPlan(null);
                      }}
                    />
                    <span className="sr-only">Keep {o.legalName}</span>
                  </label>
                </td>
                <th scope="row">{o.legalName}</th>
                <td>{o.ein ?? '—'}</td>
                <td className="num">{o.applications}</td>
                <td className="num">{o.awards}</td>
                <td className="num">{o.openReports}</td>
                <td>{o.lastActivityAt ? formatDay(o.lastActivityAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {state.kind === 'error' && (
        <p className="banner danger" role="alert">
          {state.message}
        </p>
      )}

      <div className="actions">
        {duplicates.map((d) => (
          <button
            key={d.id}
            type="button"
            className="btn secondary small"
            disabled={state.kind === 'working'}
            onClick={() => preview(d.id)}
          >
            Preview merging {d.legalName}
          </button>
        ))}
      </div>

      {plan && (
        <div className="panel-decide">
          {plan.conflicts.length > 0 ? (
            /*
              Deliberately not the applicant form's .summary error card: that
              one paints --danger-bg, a near-white pink that is only redefined
              for the light surface, and sets its text to --ink -- which on the
              dark internal theme is near-white. The result would be unreadable
              exactly where somebody is being told why a merge is unsafe.
            */
            <div role="alert">
              <h3>This cannot be merged yet</h3>
              <ul className="tally">
                {plan.conflicts.map((c) => (
                  <li key={c}>
                    <span className="meta strong" data-overdue="true">
                      {c}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>
              Merging <strong>{plan.merged.legalName}</strong> into{' '}
              <strong>{plan.survivor.legalName}</strong> moves{' '}
              {describeMoves(plan)}.
            </p>
          )}
          {plan.ok && isAdmin && (
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={state.kind === 'working'}
                onClick={merge}
              >
                Merge them
              </button>
              <button type="button" className="btn secondary" onClick={() => setPlan(null)}>
                Cancel
              </button>
            </div>
          )}
          {plan.ok && !isAdmin && (
            <p className="meta">An administrator has to do the merge itself.</p>
          )}
        </div>
      )}
    </article>
  );
}

/** How much history a record carries, for picking the likelier survivor. */
function weight(o: OrganizationSummary): number {
  return o.applications * 3 + o.awards * 5 + o.contacts + o.users;
}

/** What would move, as a sentence rather than a table of zeroes. */
export function describeMoves(plan: MergePlan): string {
  const m = plan.moves;
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(m.applications, 'application', 'applications');
  add(m.awards, 'award', 'awards');
  add(m.contacts, 'contact', 'contacts');
  add(m.users, 'sign-in', 'sign-ins');
  add(m.attachments, 'file', 'files');
  add(m.reportDrafts, 'report in progress', 'reports in progress');

  const moved = parts.length === 0 ? 'nothing across' : parts.join(', ');
  return m.contactsRetired > 0
    ? `${moved}, and retires ${m.contactsRetired} duplicate contact` +
        `${m.contactsRetired === 1 ? '' : 's'} already held under the same address`
    : moved;
}
