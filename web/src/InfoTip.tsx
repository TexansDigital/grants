/**
 * A term somebody might not know, and the sentence that explains it.
 *
 * NOT A HOVER TOOLTIP, deliberately. Hover-only content does not exist for a
 * keyboard, does not exist on a touchscreen, and fails WCAG 2.1 SC 1.4.13 --
 * and this is a staff tool somebody will open on an iPad in a meeting. A
 * button that toggles on click or Enter does the same job everywhere.
 *
 * THE EXPLANATION IS IN FLOW, not absolutely positioned. A floating panel
 * inside `.table-scroll` -- which has `overflow-x: auto` -- is clipped by its
 * own container, and the bug only appears on narrow windows where the scroll
 * is active. Pushing the surrounding content down is the lesser evil and the
 * one that cannot silently hide the thing somebody just asked to read.
 *
 * It stays in the DOM while closed, with `hidden`, so `aria-controls` always
 * points at a real element. internal.css carries the matching `[hidden]` rule
 * rather than trusting the UA default, which a `display` on the class would
 * otherwise beat.
 */

import { useId, useState, type ReactElement, type ReactNode } from 'react';

interface Props {
  /** What is being explained. Read out as "What does EIN mean?". */
  label: string;
  /**
   * A worded trigger instead of the "?" mark.
   *
   * Because the explanation opens IN FLOW, a "?" placed mid-sentence splits
   * that sentence in half when somebody uses it -- the opening clause above
   * the panel and the rest orphaned below, which reads as a broken page. So
   * prose gets a worded trigger on its own line underneath, and the bare "?"
   * is kept for the end of a short label like "EIN 00-1234567", where there
   * is no sentence left to break.
   *
   * It is also plainly more discoverable: somebody who does not know what a
   * term means does not necessarily know a "?" will tell them.
   */
  trigger?: string;
  children: ReactNode;
}

export function InfoTip({ label, trigger, children }: Props): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={trigger ? 'infotip infotip-worded' : 'infotip'}>
      <button
        type="button"
        className={trigger ? 'infotip-toggle worded' : 'infotip-toggle'}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // Escape closes it without moving focus, which is where somebody
          // reaching for it expects focus to be.
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {trigger ? (
          trigger
        ) : (
          <>
            <span aria-hidden="true">?</span>
            <span className="sr-only">
              {open ? `Hide the explanation of ${label}` : `What does ${label} mean?`}
            </span>
          </>
        )}
      </button>
      <span className="infotip-body" id={id} hidden={!open} role="note">
        {children}
      </span>
    </span>
  );
}
