/**
 * One grant, on one page.
 *
 * WHY IT EXISTS. Everything about an award -- paperwork, payments,
 * amendments, report obligations -- was rendered inside the decision panel,
 * which lives inside the application detail view. Imported awards have no
 * application, so the thirteen 2025 Inspire Change grants had no page: their
 * W-9 status, their payment schedule and their report periods were in the
 * database, served by working endpoints, and visible to nobody.
 *
 * SO THE AWARD IS THE SUBJECT AND THE APPLICATION IS A LINK. Nothing on this
 * page is phrased as though an application exists, because for every grant
 * the Foundation currently holds, none does.
 *
 * THE BLANK SECTIONS SAY WHY THEY ARE BLANK. "No report obligations" is
 * ambiguous between a grant that owes nothing and a grant nobody has asked,
 * and for these thirteen it is always the second. Worse, the two have
 * different fixes -- amend the award to give it term dates, or request the
 * update -- so the screen names which one applies and offers that step. An
 * admin should not have to know that generation requires term dates.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { AwardOverview, RelatedAward } from './api';
import { formatCents } from '../../src/lib/money';
import { formatDay } from './reportWording';
import { AwardPaperwork } from './AwardPaperwork';
import { PaymentLedger } from './PaymentLedger';
import { InfoTip } from './InfoTip';

interface Props {
  awardId: string;
  onNavigate: (path: string) => void;
}

/** A date as a person reads it, or an em dash. Never an empty cell. */
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

function relatedLabel(a: RelatedAward): string {
  return `${formatCents(a.awardedAmountCents)} · awarded ${day(a.awardedAt)}`;
}

export function AwardDetail({ awardId, onNavigate }: Props): ReactElement {
  const [data, setData] = useState<AwardOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setData(await api.award(awardId, signal));
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e), null));
      }
    },
    [awardId],
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  if (error) {
    return (
      <section className="panel">
        <h2 tabIndex={-1} data-route-heading>Grant</h2>
        <p className="banner danger" role="alert">{error.message}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel">
        <h2 tabIndex={-1} data-route-heading>Grant</h2>
        <p className="meta">Loading…</p>
      </section>
    );
  }

  /*
   * An imported award cannot be listed publicly: publicGrants evaluates a
   * communication stamp that lives on the application, and there is none. The
   * server refuses with a reason, so the screen does not offer the button --
   * a control that always errors is worse than no control.
   */
  const canPublish = data.applicationId !== null;

  async function act(what: string, run: () => Promise<string>): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(await run());
      await load();
    } catch (e) {
      /*
       * FAILURES DO NOT GO IN `notice`. It renders as a plain status banner,
       * so "that could not be done" would arrive looking exactly like "done",
       * announced politely, on a page about money. CLAUDE.md: no false green
       * lights.
       */
      setActionError(e instanceof ApiError ? e.message : `${what} did not work.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        {/*
          UP TO THE SECTION THIS PAGE LIVES IN, not back to the landing page.
          It pointed at To do, which was right when To do was the only way
          here; now that Grants is a section with a list in it, "up" means the
          list, and a reader who arrived from the compliance desk or a search
          should land somewhere they can keep looking.
        */}
        <div className="crumbs">
          <button type="button" className="linklike" onClick={() => onNavigate('/awards')}>
            Grants
          </button>
          <span aria-hidden="true">/</span>
          <span>{data.organizationName}</span>
        </div>

        <div className="panel-head">
          <h2 tabIndex={-1} data-route-heading>{data.organizationName}</h2>
          <span className={`badge badge-${data.status}`}>{data.status}</span>
          {data.isMultiYear ? <span className="badge">Multi-year</span> : null}
          {data.isPublic ? <span className="badge badge-published">Listed publicly</span> : null}
          {/*
            AFTER the badges, not between the name and its status. It sat in
            the middle and the heading read "Bayou Harbor Trust All their
            grants ACTIVE" -- a link interrupting a name and its state. The
            question a grant most often raises is "what else have we done with
            these people", and before this page existed there was nowhere to
            go and ask it.
          */}
          <button
            type="button"
            className="linklike"
            onClick={() => onNavigate(`/organizations/${data.organizationId}`)}
          >
            All their grants
          </button>
        </div>

        <dl className="facts">
          <div>
            <dt>Amount</dt>
            <dd>{formatCents(data.awardedAmountCents)}</dd>
          </div>
          <div>
            <dt>Awarded</dt>
            <dd>{day(data.awardedAt)}</dd>
          </div>
          <div>
            <dt>Grant period</dt>
            <dd>
              {data.termStart || data.termEnd ? (
                /*
                 * Each date is its own unbreakable run, so a narrow column
                 * wraps between them rather than through one -- "2025-12-" on
                 * one line and "31" on the next is not a date anybody can read
                 * at a glance.
                 */
                <>
                  <span className="nowrap">{day(data.termStart)}</span>
                  <span>to</span>
                  <span className="nowrap">{day(data.termEnd)}</span>
                </>
              ) : (
                <>
                  <span>Not recorded</span>
                  {/*
                    `label` is a TERM, not a sentence: the component builds
                    "What does X mean?" around it for the screen-reader name.
                    Passing a sentence produced "What does Why the grant period
                    matters mean?", which the browser harness read back and
                    which no unit test could have seen.
                  */}
                  <InfoTip label="the grant period">
                    Report due dates are worked out from the grant period, so an award without
                    one cannot be asked for an update until the dates are added. Add them with
                    the Amend this award form further down this page.
                  </InfoTip>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Program</dt>
            <dd>{data.programName}</dd>
          </div>
          <div>
            <dt>Cycle</dt>
            <dd>{data.cycleName ?? '—'}</dd>
          </div>
          <div>
            <dt>Announcement</dt>
            <dd>{day(data.announcementDate)}</dd>
          </div>
          <div>
            <dt>Where this came from</dt>
            <dd>
              {data.sourceSystem
                ? `Imported from ${data.sourceSystem}${data.sourceReference ? ` · ${data.sourceReference}` : ''}`
                : 'Created in Steward'}
            </dd>
          </div>
          <div>
            <dt>Application</dt>
            <dd>
              {data.applicationId ? (
                <button
                  type="button"
                  className="linklike"
                  onClick={() => onNavigate(`/applications/${data.applicationId}`)}
                >
                  {data.projectTitle ?? 'Open the application'}
                </button>
              ) : (
                <>
                  <span>None</span>
                  {/*
                    A WORDED trigger rather than a "?", which is what InfoTip's
                    own guidance says prose gets: "What does this grant having
                    no application mean?" is not a question anybody asks, and
                    the real question is short enough to be the control.
                  */}
                  <InfoTip label="" trigger="Why is there no application?">
                    This grant was recorded from a spreadsheet of past awards rather than made
                    through Steward, so there is no application behind it. That is expected for
                    every grant made before this platform existed.
                  </InfoTip>
                </>
              )}
            </dd>
          </div>
        </dl>

        {actionError ? (
          <p role="alert" className="action-error">
            {actionError}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="meta">
            {notice}
          </p>
        ) : null}

        {/*
          WHAT THIS GRANT FUNDED.
          Until 0028 this had nowhere to live. The system could say the
          Foundation gave an organization $50,000 in 2025 and nothing could say
          what for: the importer takes identity and dates, an imported award
          has no application, and the search index that carries counties and
          focus area indexes applications. So the funding history was a ledger
          of amounts with no subject matter in it at all.
        */}
        <h3 className="after-facts">What this grant funded</h3>
        <Subject award={data} busy={busy} onSaved={act} />

        <h3 className="after-facts">Public listing</h3>
        {canPublish ? (
          <p>
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() =>
                void act('Changing the listing', async () => {
                  const r = await api.setAwardPublic(awardId, !data.isPublic);
                  return r.isPublic
                    ? 'This grant is now listed on the public grants page.'
                    : 'This grant is no longer listed publicly.';
                })
              }
            >
              {data.isPublic ? 'Remove from the public page' : 'List on the public page'}
            </button>
          </p>
        ) : (
          <p className="meta">
            Imported grants cannot be listed on the public page. Publishing checks that the
            grantee was told first, and that record lives on the application, which this grant
            does not have.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Reporting</h2>
          {data.reports.length > 0 ? <span className="count">{data.reports.length}</span> : null}
        </div>

        {data.whyNoReports === 'has_reports' ? (
          <ul className="findings">
            {data.reports.map((r) => (
              <li key={r.reportPeriodId}>
                <span className="who">{r.label}</span>
                <span className="what">
                  Due {day(r.dueDate)} · {r.status.replace(/_/g, ' ')}
                  {r.overdue ? ' · overdue' : ''}
                </span>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Open ${r.label} for ${data.organizationName}`}
                  onClick={() => onNavigate(`/reporting?report=${encodeURIComponent(r.reportPeriodId)}`)}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        ) : data.whyNoReports === 'no_term_dates' ? (
          <p className="empty-reason">
            Nothing has been asked of this grantee, and nothing can be until this grant has a
            start and end date. Report periods are generated from the grant period. Add the dates
            with <strong>Amend this award</strong> below, then come back.
          </p>
        ) : (
          <>
            <p className="empty-reason">
              This grant has a start and end date but has never been asked for an update. Nothing
              has been sent to the grantee and nothing is overdue.
            </p>
            <p>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() =>
                  void act('Setting the report due dates', async () => {
                    const r = await api.generateAwardReportPeriods(awardId);
                    return r.created > 0
                      ? `Set ${r.created} report due ${r.created === 1 ? 'date' : 'dates'}. Nothing has been emailed yet.`
                      : 'No due dates were set.';
                  })
                }
              >
                Set the report due dates
              </button>
            </p>
            <p className="meta">
              This sets the dates only. Reminder emails go out on the schedule once a due date is
              close.
            </p>
          </>
        )}
      </section>

      {data.parent || data.renewals.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Related grants</h2>
          </div>
          <ul className="findings">
            {data.parent ? (
              <li>
                <span className="who">Renews</span>
                <span className="what">{relatedLabel(data.parent)}</span>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Open the grant this one renews, ${relatedLabel(data.parent)}`}
                  onClick={() => onNavigate(`/awards/${data.parent!.id}`)}
                >
                  Open
                </button>
              </li>
            ) : null}
            {data.renewals.map((r) => (
              <li key={r.id}>
                <span className="who">Renewed by</span>
                <span className="what">{relatedLabel(r)}</span>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Open the renewal, ${relatedLabel(r)}`}
                  onClick={() => onNavigate(`/awards/${r.id}`)}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Paperwork carries the amendment form, which is how term dates get
          added -- so the "add the dates" instruction above has somewhere to
          point. Payments sit below it, as they do on the decision panel. */}
      <AwardPaperwork awardId={awardId} />
      <PaymentLedger awardId={awardId} />
    </>
  );
}


/**
 * The subject-matter block: read it, or fill it in.
 *
 * NOT AN AMENDMENT FORM, and the difference shows on screen. Amending an award
 * demands a written reason because a term is moving. Writing down that a 2025
 * grant paid for literacy coaching changes nothing anybody was promised, and
 * asking "say why this award is being changed" thirteen times to fill in
 * blanks that were never filled in would teach whoever does it to type
 * anything. The save still takes the same optimistic lock, because two admins
 * cataloguing from the same spreadsheet is the scenario that lock exists for.
 */
function Subject({
  award,
  busy,
  onSaved,
}: {
  award: AwardOverview;
  busy: boolean;
  onSaved: (what: string, run: () => Promise<string>) => Promise<void>;
}): ReactElement {
  const subject = award.subject;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(subject.projectTitle ?? '');
  const [purpose, setPurpose] = useState(subject.purpose ?? '');
  const [focus, setFocus] = useState(subject.focusArea ?? '');
  const [counties, setCounties] = useState(subject.countiesServed.join(', '));

  const nothingRecorded =
    !subject.projectTitle && !subject.purpose && !subject.focusArea && subject.countiesServed.length === 0;

  function open(): void {
    // Reopen from what is on the record, not from whatever was half-typed and
    // abandoned the last time this was opened.
    setTitle(subject.projectTitle ?? '');
    setPurpose(subject.purpose ?? '');
    setFocus(subject.focusArea ?? '');
    setCounties(subject.countiesServed.join(', '));
    setEditing(true);
  }

  if (!editing) {
    return (
      <>
        {nothingRecorded ? (
          <p className="empty-reason subject-empty">
            Nothing has been recorded about what this grant was for. Until it is, this grant
            cannot be found by what it funded — only by the organization&rsquo;s name, its EIN
            and the amount.
          </p>
        ) : (
          <dl className="facts">
            {subject.projectTitle ? (
              <div>
                <dt>Title</dt>
                <dd>{subject.projectTitle}</dd>
              </div>
            ) : null}
            {subject.focusArea ? (
              <div>
                <dt>Focus area</dt>
                <dd>{subject.focusArea}</dd>
              </div>
            ) : null}
            {subject.countiesServed.length > 0 ? (
              <div>
                <dt>Counties served</dt>
                <dd>{subject.countiesServed.join(', ')}</dd>
              </div>
            ) : null}
          </dl>
        )}
        {/* The description is prose, so it sits under the facts rather than
            inside a tile beside them. */}
        {subject.purpose ? <p className="award-purpose">{subject.purpose}</p> : null}
        <p>
          <button type="button" className="btn small" disabled={busy} onClick={open}>
            {nothingRecorded ? 'Record what this grant funded' : 'Edit what this grant funded'}
          </button>
        </p>
      </>
    );
  }

  return (
    <div className="form-grid subject-form">
      <div className="filter">
        <label htmlFor="subject-title">Title</label>
        <input
          id="subject-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Campus literacy coaches"
        />
      </div>
      <div className="filter">
        <label htmlFor="subject-focus">Focus area</label>
        <input
          id="subject-focus"
          value={focus}
          maxLength={120}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Education"
        />
      </div>
      <div className="filter">
        <label htmlFor="subject-counties">Counties served</label>
        <input
          id="subject-counties"
          value={counties}
          onChange={(e) => setCounties(e.target.value)}
          placeholder="Harris, Fort Bend"
        />
        {/* Said once, here, rather than left for somebody to discover by
            typing a semicolon and losing the lot into one county name. */}
        <span className="meta">Separate them with commas.</span>
      </div>
      <div className="filter wide">
        <label htmlFor="subject-purpose">What the money paid for</label>
        <textarea
          id="subject-purpose"
          rows={4}
          value={purpose}
          maxLength={4000}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="Two full-time campus coordinators at Alief Taylor and Alief Elsik."
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void onSaved('Recording what this grant funded', async () => {
              await api.describeAward(award.awardId, {
                projectTitle: title.trim() === '' ? null : title,
                purpose: purpose.trim() === '' ? null : purpose,
                focusArea: focus.trim() === '' ? null : focus,
                /*
                 * Split, trimmed, blanks dropped. "Harris, , Fort Bend," is
                 * what a person actually types, and the server would refuse
                 * nothing here -- it drops blanks too -- but sending them
                 * would make the audit row's before/after noisier than the
                 * change it records.
                 */
                countiesServed: counties
                  .split(',')
                  .map((c) => c.trim())
                  .filter((c) => c !== ''),
                expectedUpdatedAt: award.updatedAt,
              });
              setEditing(false);
              return 'Recorded what this grant funded.';
            })
          }
        >
          Save
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
