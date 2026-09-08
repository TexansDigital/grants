/**
 * The internal shell.
 *
 * Staff-facing, so it is dark and dense: what programs exist, what cycles are
 * open, and which form definition belongs to which stage. Every row here is
 * configuration, not applicant data -- the pipeline, review and award views are
 * later phases.
 */

import type { ReactElement } from 'react';
import type { CycleRow, FormSummary, ProgramRow } from './api';

interface Props {
  programs: ProgramRow[];
  cycles: CycleRow[];
  forms: FormSummary[];
  onOpenForm: (id: string) => void;
}

export function Home({ programs, cycles, forms, onOpenForm }: Props): ReactElement {
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
                          <button type="button" className="btn small" onClick={() => onOpenForm(f.id)}>
                            Preview<span className="sr-only"> {f.name}</span>
                          </button>
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
