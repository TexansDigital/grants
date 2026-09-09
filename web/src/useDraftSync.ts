/**
 * DraftSync, wired to React.
 *
 * The state machine is in draftSync.ts and has no React in it, so the logic
 * that decides whether an applicant is told their work is safe is tested
 * directly rather than through a component. This file is the adapter: an
 * external store subscription, a stable instance across renders, and the
 * before-unload guard.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DraftSync, type DraftSyncState } from './draftSync';
import { applicantApi } from './applicantApi';

/**
 * IDENTITY MATTERS HERE, and getting it wrong is not subtle.
 *
 * `change` and `flush` are stable for the life of one sync instance, so a
 * component can put them in an effect's dependency list. The first version of
 * this hook returned a fresh object literal on every render; the autosave
 * effect depended on it, so the effect re-ran on every render, called change(),
 * which emitted new state, which re-rendered -- a loop that React killed with
 * "Maximum update depth exceeded" the moment anybody typed a single letter.
 *
 * `state` is the only field that changes between renders. Callers destructure,
 * and never depend on the handle as a whole.
 */
export interface DraftSyncHandle {
  /** False in preview, where there is no application to save against. */
  enabled: boolean;
  state: DraftSyncState;
  /** Stable identity. Safe in a dependency array. */
  change: (values: Record<string, unknown>) => void;
  /** Stable identity. Safe in a dependency array. */
  flush: () => Promise<boolean>;
}

export function useDraftSync(applicationId: string | null): DraftSyncHandle {
  /**
   * Created and destroyed by the SAME effect.
   *
   * This was a useMemo with a separate cleanup effect, and it was broken:
   * StrictMode mounts, unmounts and remounts, so the cleanup disposed the
   * memoized instance and the remount handed back the same dead object. Every
   * keystroke after that went into a disposed machine and nothing was ever
   * saved -- with the indicator sitting on "Not saved yet" as though the
   * applicant had not typed. Found by driving it in a browser; no unit test of
   * DraftSync could have seen it, because the fault was in the wiring.
   *
   * Pairing creation with disposal means a remount builds a fresh instance,
   * which is the only arrangement where "disposed" cannot outlive its owner.
   */
  const [sync, setSync] = useState<DraftSync<Record<string, unknown>> | null>(null);

  useEffect(() => {
    if (applicationId === null) {
      setSync(null);
      return undefined;
    }
    const instance = new DraftSync<Record<string, unknown>>(async (values) => {
      const out = await applicantApi.save(applicationId, values);
      return { savedAt: out.savedAt };
    });
    setSync(instance);
    return () => instance.dispose();
  }, [applicationId]);

  // A stable empty state, so the no-application case can still be read without
  // every caller branching on null before touching `.state`.
  const idle = useRef<DraftSyncState>({
    status: 'idle',
    savedAt: null,
    pendingChanges: false,
    message: null,
  });

  const state = useSyncExternalStore(
    (fn) => (sync ? sync.subscribe(() => fn()) : () => undefined),
    () => sync?.state ?? idle.current,
    () => idle.current,
  );

  // Warn before losing work the server has not got. The browser decides the
  // wording -- a custom string has been ignored for years -- so the only job
  // here is to be accurate about WHEN to ask. Asking when everything is saved
  // trains people to click through the one time it matters.
  useEffect(() => {
    if (!sync) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!sync.state.pendingChanges) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [sync]);

  const change = useCallback(
    (values: Record<string, unknown>) => {
      sync?.change(values);
    },
    [sync],
  );

  const flush = useCallback(async () => (sync ? sync.flush() : true), [sync]);

  return useMemo(
    () => ({ enabled: applicationId !== null, state, change, flush }),
    [applicationId, change, flush, state],
  );
}
