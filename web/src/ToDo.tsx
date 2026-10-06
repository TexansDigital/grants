/**
 * What needs you.
 *
 * WHY THIS IS THE LANDING PAGE. Before this screen, opening the platform put
 * you on the pipeline: a table of applications, which during the eleven months
 * of the year when no cycle is open is a table of nothing. The work that was
 * actually outstanding -- a nonprofit waiting in the claims queue, a report
 * filed three weeks ago that nobody has read, a financial statement about to
 * be destroyed -- each lived on its own tab and raised no hand. One person runs
 * this. A system that holds obligations and does not surface them is making
 * that person's memory the backup for other organizations' funding.
 *
 * WHAT THE SCREEN PROMISES. If this list is empty, nothing is outstanding.
 * That promise is the whole value, and it is why this is deliberately a short
 * list of deadlines rather than a dashboard: the moment it includes fourteen
 * standing data-quality notes, "empty" stops meaning anything and people stop
 * reading it.
 *
 * It does not ask you to configure it, filter it, or choose a view. It is a
 * list, in the order the work should be done, and every row is a link to the
 * place the work happens.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { TodoItem } from './api';

interface Props {
  onNavigate: (path: string) => void;
}

/*
 * The headings. Plain language on purpose: "Needs you now" is what a person
 * would say, and "P1" is what a ticket system would say.
 */
const GROUPS: { urgency: TodoItem['urgency']; heading: string; blurb: string }[] = [
  {
    urgency: 'now',
    heading: 'Needs you now',
    blurb: 'Somebody is waiting on the Foundation, or a date has already passed.',
  },
  {
    urgency: 'soon',
    heading: 'Coming up',
    blurb: 'Nothing is late yet. These are the dates close enough to plan around.',
  },
  {
    urgency: 'watch',
    heading: 'Keep an eye on',
    blurb: 'No action today.',
  },
];

/** A word for the kind, shown as the row's badge. */
const KIND_LABEL: Record<TodoItem['kind'], string> = {
  claim: 'Claim',
  report_filed: 'Filed',
  report_overdue: 'Overdue',
  report_due: 'Due',
  files_due: 'File',
};

/*
 * The verb on each row's button. Named by what the person is about to do
 * rather than where they are about to go, because "Reporting" is a tab and
 * "Read the report" is the job.
 */
const KIND_ACTION: Record<TodoItem['kind'], string> = {
  claim: 'Review claim',
  report_filed: 'Read report',
  report_overdue: 'Open report',
  report_due: 'Open report',
  files_due: 'Open file',
};

export function ToDo({ onNavigate }: Props): ReactElement {
  const [items, setItems] = useState<TodoItem[] | null>(null);
  /*
   * Whether the list is the WHOLE list. It is true for the next decade at this
   * Foundation's volume, and the screen's one promise collapses the moment it
   * is false and unsaid.
   */
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      try {
        const out = await api.todo(c.signal);
        setItems(out.items);
        setComplete(out.complete);
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      }
    })();
    return () => c.abort();
  }, []);

  if (error) {
    /*
     * A FAILURE HERE MUST NOT LOOK LIKE AN EMPTY LIST. This screen's one
     * promise is that nothing outstanding is missing from it, so the failure
     * state has to read as a failure. "You're all caught up" over a request
     * that never answered would be the worst lie in the system.
     */
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>To do</h2>
        </div>
        <p role="alert" className="todo-failed">
          This list could not be loaded, so it is not showing anything — including anything that
          might be outstanding. Reload the page. If it keeps failing, check Reporting and Past
          grantees directly.
        </p>
        <p className="meta">{error.message}</p>
      </section>
    );
  }

  if (items === null) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>To do</h2>
        </div>
        <p className="meta">Loading…</p>
      </section>
    );
  }

  if (items.length === 0 && complete) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>To do</h2>
        </div>
        <div className="empty">
          <p>Nothing is waiting on you.</p>
          <p className="meta">
            No unanswered claims, no reports to read, nothing overdue, and no files near
            destruction. This list covers all four — if it is empty, they are all clear.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>To do</h2>
        <span className="count">{items.length}</span>
      </div>

      {complete ? null : (
        <p role="status" className="todo-partial">
          There are more grant reports than this list can hold, so this is not all of them. Open
          Reporting for the full picture.
        </p>
      )}

      {GROUPS.map((group) => {
        const rows = items.filter((i) => i.urgency === group.urgency);
        if (rows.length === 0) return null;
        return (
          <div key={group.urgency} className="todo-group">
            <h3>{group.heading}</h3>
            <p className="meta">{group.blurb}</p>
            <ul className="todo-list">
              {rows.map((item) => (
                <li key={item.id} className="todo-item" data-urgency={item.urgency}>
                  <span className={`badge${item.kind === 'report_overdue' ? ' badge-danger' : ''}`}>
                    {KIND_LABEL[item.kind]}
                  </span>
                  <div className="todo-text">
                    <p className="todo-who">{item.title}</p>
                    <p className="todo-what">{item.detail}</p>
                  </div>
                  {item.href === null ? null : (
                    /*
                     * A button, not an anchor, because navigation here is
                     * client-side. The visible label names the job rather than
                     * the destination, and the accessible name adds the
                     * organization -- a screen reader listing the controls on
                     * this page otherwise reads "Open report" eleven times with
                     * nothing to tell them apart.
                     */
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`${KIND_ACTION[item.kind]} — ${item.title}`}
                      onClick={() => onNavigate(item.href as string)}
                    >
                      {KIND_ACTION[item.kind]}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
