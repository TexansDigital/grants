import { describe, it, expect } from 'vitest';
import { DraftSync, saveStateLabel, type DraftSyncState } from '../web/src/draftSync';

/**
 * A controllable clock and scheduler, so the tests assert on ordering rather
 * than on wall time. `tick` runs the timers whose deadline has passed.
 */
function harness() {
  let at = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let nextHandle = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const h = nextHandle++;
      timers.set(h, { due: at + ms, fn });
      return h;
    },
    clearTimer: (h: number) => void timers.delete(h),
    tick(ms: number) {
      at += ms;
      for (const [h, t] of [...timers]) {
        if (t.due <= at) {
          timers.delete(h);
          t.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

/** A save that resolves when the test says so, in the order the test chooses. */
function controllableSave() {
  const calls: { values: unknown; resolve: (iso: string) => void; reject: (e: unknown) => void }[] = [];
  const save = (values: unknown) =>
    new Promise<{ savedAt: string }>((res, rej) => {
      calls.push({
        values,
        resolve: (iso) => res({ savedAt: iso }),
        reject: rej,
      });
    });
  return { save, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
describe('autosave, coalesced', () => {
  it('does not write once per keystroke', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });

    sync.change({ a: 1 });
    h.tick(300);
    sync.change({ a: 12 });
    h.tick(300);
    sync.change({ a: 123 });
    expect(calls.length).toBe(0);

    h.tick(800);
    expect(calls.length).toBe(1);
    // The newest values, not the first ones.
    expect(calls[0]!.values).toEqual({ a: 123 });
  });

  it('schedules no timer at all while a save is open', async () => {
    // The other half of single-flight: schedule() must not queue work behind an
    // open request. Asserted on the timer count rather than the request count,
    // because run()'s own guard would hide it otherwise.
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    h.tick(10);
    expect(calls.length).toBe(1);
    expect(h.pending).toBe(0);

    sync.change({ a: 2 });
    expect(h.pending, 'nothing queued behind the open request').toBe(0);
  });

  it('schedules exactly one follow-up for changes made mid-flight', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });

    sync.change({ n: 1 });
    h.tick(800);
    expect(calls.length).toBe(1);

    // Three more changes while the first request is still open.
    sync.change({ n: 2 });
    sync.change({ n: 3 });
    sync.change({ n: 4 });
    h.tick(5000);
    expect(calls.length, 'no second request while one is in flight').toBe(1);

    calls[0]!.resolve(new Date().toISOString());
    await settle();
    h.tick(800);
    expect(calls.length).toBe(2);
    expect(calls[1]!.values).toEqual({ n: 4 });
  });
});

// ---------------------------------------------------------------------------
describe('what the applicant is told', () => {
  const stateAfter = (sync: DraftSync<unknown>): DraftSyncState => sync.state;

  it('shows Saved only once the server has confirmed it', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });

    sync.change({ a: 1 });
    expect(stateAfter(sync).savedAt, 'nothing is claimed before the request').toBeNull();
    h.tick(10);
    expect(stateAfter(sync).status).toBe('saving');
    expect(stateAfter(sync).savedAt).toBeNull();

    calls[0]!.resolve('2026-09-09T14:41:00.000Z');
    await settle();
    expect(stateAfter(sync).status).toBe('saved');
    expect(stateAfter(sync).savedAt?.toISOString()).toBe('2026-09-09T14:41:00.000Z');
    expect(stateAfter(sync).pendingChanges).toBe(false);
  });

  it('keeps exactly one save in flight, which is what makes ordering safe', async () => {
    // The out-of-order problem is prevented rather than repaired: run() refuses
    // to start while one is open, so two responses can never race. The
    // revision check inside run() is a second belt on the same trousers and is
    // unreachable while that holds -- said here rather than dressed up as a
    // test of ordering it never actually exercises.
    const h = harness();
    const calls: Array<(iso: string) => void> = [];
    const sync = new DraftSync<unknown>(
      () => new Promise<{ savedAt: string }>((res) => calls.push((iso) => res({ savedAt: iso }))),
      { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer },
    );

    sync.change({ v: 1 });
    h.tick(10);
    calls[0]!('2026-09-09T14:43:00.000Z'); // newer, arrives first
    await settle();
    sync.change({ v: 2 });
    h.tick(10);
    calls[1]!('2026-09-09T14:41:00.000Z');
    await settle();
    expect(calls.length, 'two requests, never overlapping').toBe(2);
    expect(sync.state.savedAt?.toISOString()).toBe('2026-09-09T14:41:00.000Z');
    expect(sync.state.status).toBe('saved');
  });

  it('keeps the last true timestamp when a save fails', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });

    sync.change({ a: 1 });
    h.tick(10);
    calls[0]!.resolve('2026-09-09T14:41:00.000Z');
    await settle();

    sync.change({ a: 2 });
    h.tick(10);
    calls[1]!.reject({ isOffline: true });
    await settle();

    expect(sync.state.status).toBe('failed');
    // NOT refreshed to now. The applicant's last true save is still 14:41.
    expect(sync.state.savedAt?.toISOString()).toBe('2026-09-09T14:41:00.000Z');
    expect(sync.state.pendingChanges).toBe(true);
    expect(sync.state.message).toMatch(/offline/i);
  });

  it('retries a failed save rather than giving up silently', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    h.tick(10);
    calls[0]!.reject({ isOffline: true });
    await settle();
    h.tick(10);
    expect(calls.length, 'a second attempt was scheduled').toBe(2);
  });

  it('stops retrying once the session has ended', async () => {
    // A 401 does not recover by trying again. Hammering it every debounce
    // achieves nothing and hides the one message that would help.
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    h.tick(10);
    calls[0]!.reject({ isSignedOut: true });
    await settle();

    expect(sync.state.status).toBe('signed_out');
    expect(sync.state.message).toMatch(/link in your email/i);
    sync.change({ a: 2 });
    h.tick(10_000);
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('flush, which submit depends on', () => {
  it('writes immediately and reports success', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10_000, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    const done = sync.flush();
    await settle();
    // Did not wait out the ten-second debounce.
    expect(calls.length).toBe(1);
    calls[0]!.resolve(new Date().toISOString());
    expect(await done).toBe(true);
    expect(sync.state.pendingChanges).toBe(false);
  });

  it('reports FALSE when the write failed, so submit does not proceed on a lie', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    const done = sync.flush();
    await settle();
    calls[0]!.reject({ isOffline: true });
    expect(await done).toBe(false);
  });

  it('does not start a second request when called mid-flight', async () => {
    // flush() calls run() directly, bypassing the debounce -- so run() needs
    // its OWN in-flight guard, not just the one in schedule(). Without this
    // test the two guards mask each other and either can be deleted unnoticed.
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 10, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    h.tick(10);
    expect(calls.length).toBe(1);

    sync.change({ a: 2 });
    void sync.flush();
    await settle();
    expect(calls.length, 'the open request was not joined by a second').toBe(1);
  });

  it('leaves no stray timer behind', async () => {
    // flush() must cancel the pending debounce, not race it. A timer that
    // survives is a write that fires after the applicant has already submitted.
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { debounceMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sync.change({ a: 1 });
    expect(h.pending, 'a debounce is waiting').toBe(1);
    const done = sync.flush();
    await settle();
    calls[0]!.resolve(new Date().toISOString());
    expect(await done).toBe(true);
    expect(h.pending, 'nothing left ticking').toBe(0);
  });

  it('is a no-op with nothing outstanding', async () => {
    const h = harness();
    const { save, calls } = controllableSave();
    const sync = new DraftSync(save, { setTimer: h.setTimer, clearTimer: h.clearTimer });
    expect(await sync.flush()).toBe(true);
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the sentence on screen', () => {
  const base: DraftSyncState = { status: 'saved', savedAt: null, pendingChanges: false, message: null };
  const at = (iso: string) => new Date(iso);

  it('carries a time, not just the word Saved', () => {
    const saved = at('2026-09-09T14:41:00.000Z');
    expect(saveStateLabel({ ...base, savedAt: saved }, at('2026-09-09T14:41:03.000Z')))
      .toBe('Saved just now');
    expect(saveStateLabel({ ...base, savedAt: saved }, at('2026-09-09T14:41:30.000Z')))
      .toBe('Saved 30 seconds ago');
    // Past a minute it becomes a clock time, which is what somebody deciding
    // whether to close the tab actually needs.
    expect(saveStateLabel({ ...base, savedAt: saved }, at('2026-09-09T15:10:00.000Z')))
      .toMatch(/^Saved \d/);
  });

  it('says so when there is work the server has not got', () => {
    const s = { ...base, savedAt: at('2026-09-09T14:41:00.000Z'), pendingChanges: true };
    expect(saveStateLabel(s, at('2026-09-09T14:41:02.000Z')))
      .toBe('Saved just now — new changes not yet saved');
  });

  it('never says Saved when it is not', () => {
    for (const s of [
      { ...base, status: 'failed' as const, message: 'Not saved. We will try again in a moment.' },
      { ...base, status: 'signed_out' as const },
      { ...base, status: 'saving' as const },
      { ...base, status: 'idle' as const },
    ]) {
      expect(saveStateLabel(s), s.status).not.toMatch(/^Saved/);
    }
  });
});
