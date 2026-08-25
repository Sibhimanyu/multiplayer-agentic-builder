// Injectable clock. A9 (stale after 90s) and the reaper are untestable against
// a real clock, and a test that sleeps 90 seconds is a test nobody runs.

export interface Clock {
  now(): number; // epoch ms
  iso(): string; // RFC3339 of now()
  /** Resolves after ms of clock time. FakeClock resolves on advance(). */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class FakeClock implements Clock {
  #ms: number;
  #waiters: { at: number; resolve: () => void }[] = [];

  constructor(start: number | string = '2026-08-25T09:00:00.000Z') {
    this.#ms = typeof start === 'string' ? new Date(start).getTime() : start;
  }

  now(): number { return this.#ms; }
  iso(): string { return new Date(this.#ms).toISOString(); }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#waiters.push({ at: this.#ms + ms, resolve }); });
  }

  /** Move time forward and release every waiter whose deadline has passed. */
  async advance(ms: number): Promise<void> {
    this.#ms += ms;
    const due = this.#waiters.filter((w) => w.at <= this.#ms);
    this.#waiters = this.#waiters.filter((w) => w.at > this.#ms);
    for (const w of due) w.resolve();
    // Let the released continuations run before returning to the caller.
    await Promise.resolve();
    await Promise.resolve();
  }

  get pending(): number { return this.#waiters.length; }
}
