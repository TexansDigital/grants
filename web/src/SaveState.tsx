/**
 * The saved-state indicator.
 *
 * Extracted so the applicant form and the grantee report show the SAME words
 * for the same state. "Saved at 19:41" means one thing and it has to mean it
 * on both surfaces; two copies is how one of them ends up saying "Saved" for a
 * write that did not land.
 *
 * It re-renders on a timer because the label is relative ("Saved a minute
 * ago"), and a relative time that never updates is worse than an absolute one.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { saveStateLabel, type DraftSyncState } from './draftSync';

export function ServerSaveState({ state }: { state: DraftSyncState }): ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Announce a CHANGE, not every tick. A polite live region that fires every
  // fifteen seconds reads the same sentence over a screen reader user's typing.
  const announced = useRef(state.status);
  const changed = announced.current !== state.status;
  announced.current = state.status;
  const bad = state.status === 'failed' || state.status === 'signed_out';

  return (
    <span
      className={bad ? 'counter danger' : 'counter'}
      role={bad ? 'status' : undefined}
      aria-live={bad ? 'assertive' : changed ? 'polite' : 'off'}
    >
      {saveStateLabel(state)}
    </span>
  );
}
