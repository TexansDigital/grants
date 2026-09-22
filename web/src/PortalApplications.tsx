/**
 * The organization's applications, and the way to start another.
 *
 * WHY THIS EXISTS. Two dead ends met on one page.
 *
 * AN APPLICATION HAD NOWHERE TO LIVE. `listApplicationsForExternal` was
 * written in Phase 1, correctly scoped and masked, and nothing ever called it.
 * So somebody who submitted and closed the tab had no page that said so: the
 * read-back lived at a URL they would have had to keep, and signing in again
 * landed them on "there are no grants on this account yet". Did it go through
 * is the commonest question an applicant has, and the product had no answer.
 *
 * AND THERE WAS NO WAY BACK OUT. The portal shell carries no navigation -- by
 * design, when the portal was only a grantee's reporting page and there was
 * genuinely nowhere else to go. There are three external destinations now, and
 * a signed-in nonprofit could not reach the one that matters: a program
 * officer reporting on last year's grant, or a declined applicant reapplying,
 * had to be sent a link or type a path.
 *
 * THE STATUS SHOWN IS THE SERVER'S. It is masked before it leaves the Worker,
 * because an application becomes 'declined' the instant an admin records the
 * decision -- days before a human finishes the letter. Nothing here re-derives
 * an outcome from a date or a title, and the wording below never implies one
 * the server has not sent.
 */

import type { ReactElement } from 'react';
import type { ApplicationSummary } from './granteeApi';
import type { OpenCycle } from './publicApi';
import { formatDay } from './reportWording';

interface Props {
  applications: ApplicationSummary[];
  /** Open cycles, so "apply again" is a button rather than a path to type. */
  openCycles: OpenCycle[];
  onStartApplication: () => void;
  onOpenApplication: (id: string) => void;
}

/**
 * What each state is called, to the person who is in it.
 *
 * `under_review` covers a decision that has been made and not yet delivered,
 * and the wording has to be true in both cases: "with us" is, "not decided
 * yet" would not be.
 */
const STATE: Record<string, { chip: string; tone: 'todo' | 'late' | 'resting'; line: string }> = {
  draft: {
    chip: 'Not sent',
    tone: 'todo',
    line: 'Started but not submitted. You can carry on where you left off.',
  },
  submitted: {
    chip: 'Received',
    tone: 'resting',
    line: 'We have it. You do not need to do anything else for now.',
  },
  under_review: {
    chip: 'With us',
    tone: 'resting',
    line: 'Being considered. We will write to you either way.',
  },
  awarded: { chip: 'Awarded', tone: 'resting', line: 'Funded. Your grant is above.' },
  declined: {
    chip: 'Not funded',
    tone: 'resting',
    line: 'Not funded this time. You are welcome to apply again in a future cycle.',
  },
  withdrawn: { chip: 'Withdrawn', tone: 'resting', line: 'Withdrawn at your request.' },
};

export function PortalApplications({
  applications,
  openCycles,
  onStartApplication,
  onOpenApplication,
}: Props): ReactElement | null {
  const drafts = applications.filter((a) => a.status === 'draft');
  const sent = applications.filter((a) => a.status !== 'draft');

  // Nothing to say and nowhere to go: render nothing rather than an empty
  // heading. The portal's own empty state already speaks.
  if (applications.length === 0 && openCycles.length === 0) return null;

  return (
    <section className="card portal-award" aria-labelledby="applications-heading">
      <div className="portal-award-head">
        <h3 id="applications-heading">
          {applications.length === 0 ? 'Apply for a grant' : 'Your applications'}
        </h3>
      </div>

      {applications.length > 0 && (
        <ul className="portal-list">
          {[...drafts, ...sent].map((a) => {
            const state = STATE[a.status] ?? {
              chip: a.status,
              tone: 'resting' as const,
              line: '',
            };
            return (
              <li key={a.id}>
                <div className="portal-report-row">
                  <div>
                    <p className="portal-report-title">
                      {a.projectTitle ?? a.programName ?? 'Grant application'}
                      <span className="portal-chip" data-tone={state.tone}>
                        {state.chip}
                      </span>
                    </p>
                    <p className="portal-meta">
                      {[a.programName, a.cycleName].filter(Boolean).join(' · ')}
                      {a.submittedAt && ` · Sent ${formatDay(a.submittedAt)}`}
                    </p>
                    {state.line && <p className="portal-due">{state.line}</p>}
                  </div>
                  {/*
                    A DRAFT IS THE ONLY ONE WITH A BUTTON. A submitted
                    application opens to a read-only copy, which is worth
                    having, but putting the same weight on it as on an
                    unfinished form would send somebody to the wrong one when
                    both are on screen.
                  */}
                  <button
                    type="button"
                    className={a.status === 'draft' ? 'btn' : 'btn secondary'}
                    onClick={() => onOpenApplication(a.id)}
                  >
                    {a.status === 'draft' ? 'Carry on' : 'View'}
                    <span className="sr-only">
                      {' '}
                      {a.projectTitle ?? a.programName ?? 'this application'}
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {openCycles.length > 0 && (
        <div className="portal-apply">
          <p className="portal-meta">
            {openCycles.length === 1
              ? `${openCycles[0]!.programName} is accepting applications.`
              : `${openCycles.length} programs are accepting applications.`}
          </p>
          <button type="button" className="btn secondary" onClick={onStartApplication}>
            {applications.length === 0 ? 'See open grant programs' : 'Apply for another grant'}
          </button>
        </div>
      )}
    </section>
  );
}
