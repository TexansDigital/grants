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
import type { CycleRow, FormSummary, ProgramRow } from './api';

interface Props {
  programs: ProgramRow[];
  cycles: CycleRow[];
  forms: FormSummary[];
  isAdmin: boolean;
  onOpenForm: (id: string) => void;
  /** Reload the configuration after a form is built or published. */
  onChanged: () => void;
}

export function Home({
  programs,
  cycles,
  forms,
  isAdmin,
  onOpenForm,
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
        {programs.length === 0 && (
          <div className="state">
            <h1>No programs yet</h1>
            <p>
              Nothing has been seeded into this database. Run <code>npm run seed:preview</code>{' '}
              to load the Inspire Change program and its form definition.
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
              </div>

              <h3>Cycles</h3>
              {programCycles.length === 0 ? (
                <p className="meta">No cycles defined.</p>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}

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
    </>
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
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const build = useCallback(async () => {
    setState({ kind: 'working' });
    try {
      await api.buildReportForm(programId);
      setState({ kind: 'idle' });
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
