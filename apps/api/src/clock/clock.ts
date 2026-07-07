// Injectable time. Every money/expiry decision (quote TTL, the 7-day repeat
// window) reads the clock through this port so tests can advance time
// deterministically instead of sleeping against the wall clock.
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test clock: starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    // Return a copy so callers can't mutate our internal instant.
    return new Date(this.current.getTime());
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }
}

/** Nest DI token for the active Clock. */
export const CLOCK = Symbol('CLOCK');
