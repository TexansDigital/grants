/**
 * The internal shell.
 *
 * Staff-facing, so it is dark and dense: what programs exist, what cycles are
 * open, and which form definition belongs to which stage. Every row here is
 * configuration, not applicant data -- the pipeline, review and award views are
 * later phases.
 */

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, api } from './api';
import type { CycleRow, FormSummary, ProgramRow, RequestUpdatesResult } from './api';
import { formatCents } from '../../src/lib/money';
import { AwardsImport } from './AwardsImport';
import { NewProgram, NewCycle, CycleStatusButton } from './Configure';

interface Props {
  programs: ProgramRow[];
  cycles: CycleRow[];
  forms: FormSummary[];
  isAdmin: boolean;
  onOpenForm: (id: string) => void;
  /** The rubric builder for one program. */
  onOpenRubrics: (programId: string) => void;
  /** The decision-letter desk for one cycle. */
  onOpenLetters: (cycleId: string) => void;
  /** The offline scorecard fallback for one cycle. */
  onOpenScorecards: (cycleId: string) => void;
  /** Reviewer coverage, and the disclosures waiting on somebody. */
  onOpenCoverage: (cycleId: string) => void;
  /** Reload the configuration after a form is built or published. */
  onChanged: () => void;
}

export function Home({
  programs,
  cycles,
  forms,
  isAdmin,
  onOpenForm,
  onOpenRubrics,
  onOpenLetters,
  onOpenScorecards,
  onOpenCoverage,
  onChanged,
}: Props): ReactElement {
  const cyclesByProgram = new Map<string, CycleRow[]>();
  for (const c of cycles) {
    const list = cyclesByProgram.get(c.program_id) ?? [];
    list.push(c);
    cyclesByProgram.set(c.program_id, list);
  }
  const formsByProgram = new Map<string, FormSummary[]>();
  for (const f of forms) {
    const list = formsByProgram.get(f.program_id) ?? [];
    list.push(f);
    formsByProgram.set(f.program_id, list);
  }

  return (
    <>
        {isAdmin && <NewProgram onChanged={onChanged} />}

        {programs.length === 0 && (
          <div className="state">
            <h1>No programs yet</h1>
            <p>
              A program is the container for stages, cycles, forms and metrics. Create one here,
              or load the Inspire Change seed with <code>npm run seed:preview</code>.
            </p>
          </div>
        )}

        {programs.map((p) => {
          const programCycles = cyclesByProgram.get(p.id) ?? [];
          const programForms = formsByProgram.get(p.id) ?? [];
          return (
            <section className="panel" key={p.id}>
              <div className="panel-head">
                <h2 tabIndex={-1} data-route-heading>
                  {p.name}
                </h2>
                <span className={`badge badge-${p.status}`}>{p.status}</span>
                {p.fiscal_year !== null && <span className="meta">FY{p.fiscal_year}</span>}
                <span className="meta">overdue reports: {p.compliance_policy}</span>
                {isAdmin && (
                  /*
                   * A button, not an <a href>, and deliberately.
                   *
                   * Staff paths are not served by the Worker -- only the
                   * public shells are listed there -- so a real page load on
                   * /programs/:id/rubrics 404s. Every staff navigation in this
                   * app goes through the client router, and this one has to as
                   * well. Making these deep-linkable is its own change and is
                   * recorded as a gap rather than half-done here.
                   */
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() => onOpenRubrics(p.id)}
                  >
                    Scoring rubrics<span className="sr-only"> for {p.name}</span>
                  </button>
                )}
              </div>

              <h3>Cycles</h3>
              {isAdmin && (
                <NewCycle programId={p.id} programName={p.name} onChanged={onChanged} />
              )}
              {programCycles.length === 0 ? (
                <p className="meta">
                  No cycles defined. Nothing about this program is public until a cycle exists and
                  is opened.
                </p>
              ) : (
                <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Cycle</th>
                      <th scope="col">Opens</th>
                      <th scope="col">Closes</th>
                      <th scope="col">Status</th>
                      <th scope="col">Draft grace</th>
                      <th scope="col">
                        <span className="sr-only">Open or close</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {programCycles.map((c) => (
                      <tr key={c.id}>
                        <th scope="row">{c.name}</th>
                        {/* Central time, computed by the Worker so every
                            surface shows the same string. Storage is UTC. */}
                        <td>{c.opens_at_display}</td>
                        <td>{c.closes_at_display}</td>
                        <td>
                          <span className={`badge badge-${c.status}`}>{c.status}</span>
                        </td>
                        <td className="num">
                          {c.draft_grace_hours === null ? '—' : `${c.draft_grace_hours} h`}
                        </td>
                        <td className="row-actions">
                          {isAdmin && <CycleStatusButton cycle={c} onChanged={onChanged} />}
                          {isAdmin && (
                            // The decision-letter desk for this cycle. Reached
                            // from the cycle because that is the unit the week
                            // is worked in: all its awards, then all its
                            // declines.
                            <button
                              type="button"
                              className="btn secondary small"
                              onClick={() => onOpenLetters(c.id)}
                            >
                              Letters<span className="sr-only"> for {c.name}</span>
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              className="btn secondary small"
                              onClick={() => onOpenScorecards(c.id)}
                            >
                              Scorecards<span className="sr-only"> for {c.name}</span>
                            </button>
                          )}
                          {isAdmin && (
                            // Coverage, and the conflict disclosures waiting on
                            // an admin. Both endpoints existed with no door,
                            // so an application short of reviewers and a
                            // reviewer blocked by their own disclosure were
                            // equally invisible until the deadline.
                            <button
                              type="button"
                              className="btn secondary small"
                              onClick={() => onOpenCoverage(c.id)}
                            >
                              Coverage<span className="sr-only"> for {c.name}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}

              {isAdmin && <RequestUpdatesPanel programId={p.id} />}

              <h3>Form definitions</h3>
              {isAdmin && <ReportFormControls programId={p.id} onChanged={onChanged} />}
              {programForms.length === 0 ? (
                <p className="meta">No forms defined.</p>
              ) : (
                <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Form</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Version</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {programForms.map((f) => (
                      <tr key={f.id}>
                        <th scope="row">{f.name}</th>
                        <td>{f.stage_name ?? '—'}</td>
                        <td>{f.kind}</td>
                        <td className="num">{f.version}</td>
                        <td>
                          <span className={`badge badge-${f.status}`}>{f.status}</span>
                        </td>
                        <td>
                          <button type="button" className="btn small secondary" onClick={() => onOpenForm(f.id)}>
                            Preview<span className="sr-only"> {f.name}</span>
                          </button>
                          {isAdmin && f.kind === 'report' && f.status === 'draft' && (
                            <PublishButton formId={f.id} name={f.name} onChanged={onChanged} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </section>
          );
        })}

        {/*
          Loading historical grants. It belongs on the configuration screen
          because it is setup rather than day-to-day work, and because until it
          has run there is nothing for the rest of the platform to be about.
        */}
        <AwardsImport isAdmin={isAdmin} />

    </>
  );
}

/**
 * Ask past grantees for an update, with a due date the Foundation chooses.
 *
 * WHY A DRY RUN IS THE DEFAULT AND THE ONLY FIRST STEP. Pressing this creates
 * an obligation against somebody else's grant, with a date they will be held
 * to, for every grant in a window at once. Thirteen of them is one press. So
 * the first press only ever counts, names the organizations, and shows what
 * would be skipped; the second one writes.
 *
 * The window is AWARD DATES rather than a fiscal year, because an award does
 * not carry a fiscal year -- and because it means nobody has to agree with this
 * software about when their year starts.
 */
function RequestUpdatesPanel({ programId }: { programId: string }): ReactElement {
  const [from, setFrom] = useState('2025-01-01');
  const [to, setTo] = useState('2025-12-31');
  const [label, setLabel] = useState('2025 grant update');
  const [due, setDue] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'planned'; plan: RequestUpdatesResult }
    | { kind: 'done'; plan: RequestUpdatesResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const run = useCallback(
    async (dryRun: boolean) => {
      setState({ kind: 'working' });
      try {
        const plan = await api.requestUpdates(programId, {
          awardedFrom: from, awardedTo: to, label, dueDate: due, dryRun,
        });
        setState({ kind: dryRun ? 'planned' : 'done', plan });
      } catch (e) {
        setState({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'That did not work. Try again.',
        });
      }
    },
    [programId, from, to, label, due],
  );

  const plan = state.kind === 'planned' ? state.plan : null;
  const done = state.kind === 'done' ? state.plan : null;

  return (
    <section className="request-updates">
      <h3>Ask past grantees for an update</h3>
      <p className="meta">
        Creates one update request per grant awarded in this window, due on the date you set.
        Nothing is written until you have seen the list.
      </p>

      <div className="request-updates-fields">
        <label>
          Grants awarded from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          What the grantee sees it called
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="2025 grant update"
          />
        </label>
        <label>
          Due
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>

      <p className="meta">
        <button
          type="button"
          className="btn small secondary"
          disabled={state.kind === 'working'}
          onClick={() => void run(true)}
        >
          {state.kind === 'working' ? 'Checking…' : 'Show me what this would do'}
        </button>
      </p>

      {state.kind === 'error' && (
        <p className="meta strong" role="alert" data-overdue="true">
          {state.message}
        </p>
      )}

      {plan && (
        <div className="request-updates-plan">
          {plan.formDefinitionId === null && (
            /*
             * Stated rather than blocking. The obligation is real and dated
             * either way; it simply cannot be filled in until a form exists,
             * and refusing to let the Foundation decide WHO to ask before they
             * have decided WHAT to ask would be the wrong order.
             */
            <p className="meta strong" data-overdue="true">
              No report form is published for this program yet, so these grantees will have
              nothing to fill in until one is. The request is still created with its date.
            </p>
          )}
          <p className="meta">
            <strong>
              {plan.willAsk.length === 0
                ? 'No grants would be asked.'
                : `${plan.willAsk.length} grant${plan.willAsk.length === 1 ? '' : 's'} would be asked, due ${plan.dueDate}.`}
            </strong>
          </p>
          {plan.willAsk.length > 0 && (
            <ul className="meta">
              {plan.willAsk.map((r) => (
                <li key={r.awardId}>
                  {r.organizationName} — {formatCents(r.awardedAmountCents)}
                </li>
              ))}
            </ul>
          )}
          {plan.skipped.length > 0 && (
            <>
              <p className="meta">Skipped:</p>
              <ul className="meta">
                {plan.skipped.map((r) => (
                  <li key={r.awardId}>
                    {r.organizationName} — {r.skipped}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.willAsk.length > 0 && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                const ok = window.confirm(
                  `Ask ${plan.willAsk.length} organization(s) for an update, due ${plan.dueDate}? ` +
                    'They will be able to file as soon as this is done.',
                );
                if (ok) void run(false);
              }}
            >
              Ask {plan.willAsk.length} organization{plan.willAsk.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {done && (
        <p className="meta strong" role="status">
          {done.created} update request{done.created === 1 ? '' : 's'} created, due {done.dueDate}.
          Tell those organizations to go to the past-grantee page and we will connect them.
        </p>
      )}
    </section>
  );
}

/**
 * Build a draft report form from this program's impact metrics.
 *
 * Always a DRAFT. Publishing is a second, separate press, because a published
 * form can never be edited again -- and an admin who has not read the generated
 * wording should not be one click from freezing it.
 */
function ReportFormControls({
  programId,
  onChanged,
}: {
  programId: string;
  onChanged: () => void;
}): ReactElement {
  /*
   * SAY WHAT IT DID. This returned to idle on success and showed nothing: the
   * new draft appears in a table lower down the page, below the fold on a
   * laptop, so an admin who pressed it saw a button stop being busy and
   * nothing else. They pressed it again. Three identical drafts in preview is
   * how that was found, and it was found by a person rather than by any test
   * here -- a silent success is indistinguishable from a silent failure, and
   * the only honest fix is for the control to report.
   */
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'built'; version: number; fieldCount: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const build = useCallback(async () => {
    setState({ kind: 'working' });
    try {
      const out = await api.buildReportForm(programId);
      setState({ kind: 'built', version: out.version, fieldCount: out.fieldCount });
      onChanged();
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'That did not work. Try again.',
      });
    }
  }, [onChanged, programId]);

  return (
    <p className="meta">
      <button
        type="button"
        className="btn small secondary"
        disabled={state.kind === 'working'}
        onClick={build}
      >
        {state.kind === 'working' ? 'Building…' : 'Build a report form from this program\u2019s metrics'}
      </button>
      {state.kind === 'built' && (
        <span className="meta strong" role="status">
          {' '}Draft version {state.version} built, with {state.fieldCount} question
          {state.fieldCount === 1 ? '' : 's'}. Read it in the table below, then Publish it.
          Pressing this again makes another draft.
        </span>
      )}
      {state.kind === 'error' && (
        <span className="meta strong" role="alert" data-overdue="true">
          {state.message}
        </span>
      )}
    </p>
  );
}

/**
 * Publish a draft report form.
 *
 * The confirm is not decoration. Publishing freezes the wording for good AND
 * opens every report obligation that has been waiting for a form -- which,
 * after an awards import, is every grant in the program. Both of those are
 * worth one deliberate pause.
 */
function PublishButton({
  formId,
  name,
  onChanged,
}: {
  formId: string;
  name: string;
  onChanged: () => void;
}): ReactElement {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const publish = useCallback(async () => {
    const ok = window.confirm(
      'Publishing freezes this wording permanently and opens every report that has been ' +
        'waiting for a form. Continue?',
    );
    if (!ok) return;
    setState({ kind: 'working' });
    try {
      const out = await api.publishForm(formId);
      window.alert(
        out.periodsAttached === 0
          ? 'Published. No reports were waiting for a form.'
          : `Published, and ${out.periodsAttached} report${
              out.periodsAttached === 1 ? ' is' : 's are'
            } now open to their grantees.`,
      );
      setState({ kind: 'idle' });
      onChanged();
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiError ? e.message : 'That did not work. Try again.',
      });
    }
  }, [formId, onChanged]);

  return (
    <>
      <button
        type="button"
        className="btn small"
        disabled={state.kind === 'working'}
        onClick={publish}
      >
        {state.kind === 'working' ? 'Publishing…' : 'Publish'}
        <span className="sr-only"> {name}</span>
      </button>
      {state.kind === 'error' && (
        <span className="meta strong" role="alert" data-overdue="true">
          {state.message}
        </span>
      )}
    </>
  );
}
