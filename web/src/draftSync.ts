/**
 * Autosave, as a state machine with no React in it.
 *
 * This is the piece that decides whether an applicant is told their work is
 * safe. Getting it wrong is worse than not having it: the failure mode of
 * autosave is not "it did not save", it is "it said Saved and did not", and
 * somebody closes the laptop.
 *
 * Four things it has to get right, none of which are obvious:
 *
 *   1. COALESCING. Typing is not one request per keystroke, and a change made
 *      while a save is in flight schedules exactly one follow-up rather than
 *      queueing a request per change.
 *   2. ORDERING, prevented rather than repaired. Exactly one save is ever in
 *      flight, so two responses cannot race and stamp an older result over a
 *      newer one. The revision check in `run` is a second belt on the same
 *      trousers, and is unreachable while single-flight holds.
 *   3. HONESTY. `savedAt` is set only by a confirmed server response. There is
 *      no optimistic path -- an indicator that runs ahead of the server is the
 *      exact lie this class exists to prevent.
 *   4. UNSAVED WORK IS KNOWN. `pendingChanges` stays true until the revision
 *      that produced it is confirmed, so the page can warn before it closes.
 *
 * It is framework-free so it can be tested directly, with an injected clock
 * and scheduler, rather than through a component and a fake DOM.
 */

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'signed_out';

export interface DraftSyncState {
  status: SaveStatus;
  /** Confirmed by the server. Never set optimistically. */
  savedAt: Date | null;
  /** Changes made since the last confirmed save. */
  pendingChanges: boolean;
  /** Why the last save failed, in words an applicant can act on. */
  message: string | null;
}

export interface SaveOutcome {
  savedAt: string;
}

export interface DraftSyncOptions {
  /** How long typing settles before a write. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** Distinguishes "try again" from "your session ended". */
export interface SaveError {
  isSignedOut?: boolean;
  isOffline?: boolean;
  message?: string;
}

export class DraftSync<V> {
  private readonly save: (values: V) => Promise<SaveOutcome>;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private listeners = new Set<(s: DraftSyncState) => void>();
  private timer: number | null = null;
  private latest: V | null = null;
  private inFlight = false;
  private disposed = false;

  /** Bumped on every change; compared against `confirmed` to detect drift. */
  private revision = 0;
  private confirmed = 0;

  private current: DraftSyncState = {
    status: 'idle',
    savedAt: null,
    pendingChanges: false,
    message: null,
  };

  constructor(save: (values: V) => Promise<SaveOutcome>, opts: DraftSyncOptions = {}) {
    this.save = save;
    this.debounceMs = opts.debounceMs ?? 800;
    // Bare setTimeout, not window.setTimeout: this class is deliberately
    // environment-free so its tests run in the same Workers runtime as the
    // rest of the suite rather than needing a fake DOM. The cast is the only
    // honest way across the two typings of the handle.
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as unknown as number));
  }

  get state(): DraftSyncState {
    return this.current;
  }

  subscribe(fn: (s: DraftSyncState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Record a change and schedule a save. */
  change(values: V): void {
    if (this.disposed) return;
    this.latest = values;
    this.revision += 1;
    this.emit({ pendingChanges: true });
    this.schedule();
  }

  /**
   * Save now, and resolve when the server has confirmed everything changed so
   * far. Called on blur, and before submit.
   *
   * Resolves `false` when there is still unconfirmed work -- a caller about to
   * submit needs to know that, and a thrown error would make every blur a
   * potential unhandled rejection.
   */
  async flush(): Promise<boolean> {
    if (this.disposed) return !this.current.pendingChanges;
    this.cancelTimer();
    // Two passes at most: one for whatever is outstanding now, and one for a
    // change that landed while that was in flight. Beyond that, a caller is
    // racing a typist and the answer is honestly "not yet".
    for (let i = 0; i < 2; i += 1) {
      if (!this.current.pendingChanges) return true;
      await this.run();
      const outcome = this.state.status;
      if (outcome === 'failed' || outcome === 'signed_out') return false;
    }
    return !this.current.pendingChanges;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------

  private schedule(): void {
    this.cancelTimer();
    // A save is already going out. It will pick up the newest values when it
    // finishes; scheduling a second one now would double the writes.
    if (this.inFlight) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    if (this.inFlight || this.latest === null || this.disposed) return;
    // A session that has ended does not recover by retrying. Stop, and let the
    // UI say so, rather than hammering a 401 every 800ms.
    if (this.current.status === 'signed_out') return;

    const attempt = this.revision;
    const values = this.latest;
    this.inFlight = true;
    this.emit({ status: 'saving', message: null });

    try {
      const out = await this.save(values);
      // Unreachable while `run` keeps a single save in flight: `attempt` is
      // always ahead of `confirmed` there. Kept because the day someone
      // relaxes the in-flight lock for parallel section saves, this is the
      // line that stops the indicator going backwards.
      if (attempt > this.confirmed) {
        this.confirmed = attempt;
        this.emit({
          status: 'saved',
          savedAt: new Date(out.savedAt),
          pendingChanges: this.revision > attempt,
          message: null,
        });
      }
    } catch (err) {
      const e = err as SaveError;
      if (e?.isSignedOut) {
        this.emit({
          status: 'signed_out',
          message: 'Your sign-in has expired. Open the link in your email again to continue.',
        });
      } else {
        this.emit({
          status: 'failed',
          // No savedAt change: a failed save leaves the last true timestamp
          // standing rather than replacing it with a fresher lie.
          message:
            e?.isOffline === true
              ? 'Not saved — you appear to be offline. Keep this page open; we will keep trying.'
              : 'Not saved. We will try again in a moment.',
        });
      }
    } finally {
      this.inFlight = false;
    }

    // Something changed while that was in flight, or that attempt failed and
    // is worth retrying. Either way, go round again after the debounce.
    const after = this.state;
    if (!this.disposed && after.pendingChanges && after.status !== 'signed_out') {
      this.schedule();
    }
  }

  private emit(patch: Partial<DraftSyncState>): void {
    const next: DraftSyncState = { ...this.current, ...patch };
    if (patch.pendingChanges === undefined) {
      next.pendingChanges = this.revision > this.confirmed;
    }
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }
}

/**
 * The saved-state sentence.
 *
 * Deliberately not "Saved" alone. A timestamp is what lets somebody decide
 * whether to risk closing the tab, and "Saved" with no time is the same
 * reassurance whether the last write was two seconds or two hours ago.
 */
export function saveStateLabel(s: DraftSyncState, now: Date = new Date()): string {
  if (s.status === 'signed_out') return 'Not saved — your sign-in expired';
  if (s.status === 'failed') return s.message ?? 'Not saved';
  if (s.status === 'saving') return 'Saving…';
  if (s.savedAt === null) return 'Not saved yet';
  const seconds = Math.max(0, Math.round((now.getTime() - s.savedAt.getTime()) / 1000));
  const when =
    seconds < 10
      ? 'just now'
      : seconds < 60
        ? `${seconds} seconds ago`
        : s.savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return s.pendingChanges ? `Saved ${when} — new changes not yet saved` : `Saved ${when}`;
}
