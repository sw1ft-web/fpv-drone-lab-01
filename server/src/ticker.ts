/**
 * Fixed-rate loop with drift correction.
 *
 * `setInterval(fn, 33)` drifts and fires late; instead every tick has an
 * absolute deadline (`start + n * interval`). We sleep with setTimeout until
 * ~2 ms before it, then yield through setImmediate until the deadline passes,
 * which keeps timer slack out of the tick without blocking the event loop.
 * Lateness (jitter) and the cost of each tick are recorded for /api/stats.
 *
 * `now`, `setTimer` and `setImmediateFn` are injectable so the loop can be
 * tested on a virtual clock.
 */
export interface TickerOptions {
  hz: number;
  onTick: (tick: number) => void;
  now?: () => number;
  /** Schedules `fn`; returns the function that cancels it. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  setImmediateFn?: (fn: () => void) => unknown;
  spinMs?: number;
  maxCatchUpTicks?: number;
  window?: number;
}

export interface TickerStats {
  hz: number;
  ticks: number;
  skippedTicks: number;
  durationP50Ms: number;
  durationP99Ms: number;
  durationMaxMs: number;
  latenessP50Ms: number;
  latenessP99Ms: number;
}

export interface Ticker {
  start(): void;
  stop(): void;
  readonly running: boolean;
  stats(): TickerStats;
}

export function createTicker({
  hz,
  onTick,
  now = () => performance.now(),
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  setImmediateFn = (fn) => setImmediate(fn),
  spinMs = 2,
  maxCatchUpTicks = 4,
  window = 600,
}: TickerOptions): Ticker {
  const interval = 1000 / hz;
  const durations: number[] = [];
  const lateness: number[] = [];
  let next = 0;
  let cancelTimer: (() => void) | null = null;
  let running = false;
  let ticks = 0;
  let skipped = 0;

  const push = (list: number[], value: number): void => {
    list.push(value);
    if (list.length > window) list.shift();
  };

  const percentile = (list: number[], q: number): number => {
    if (list.length === 0) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return (
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    );
  };

  function arm(): void {
    if (!running) return;
    cancelTimer = setTimer(wake, Math.max(0, next - now() - spinMs));
  }

  function wake(): void {
    if (!running) return;
    if (now() < next) {
      setImmediateFn(wake);
      return;
    }
    const startedAt = now();
    push(lateness, startedAt - next);
    try {
      onTick(ticks);
    } finally {
      ticks += 1;
      push(durations, now() - startedAt);
      next += interval;
      if (now() > next + interval * maxCatchUpTicks) {
        // We are hopelessly behind: skip ahead instead of spiralling.
        skipped += Math.floor((now() - next) / interval);
        next = now() + interval;
      }
      arm();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      next = now() + interval;
      arm();
    },
    stop() {
      running = false;
      cancelTimer?.();
      cancelTimer = null;
    },
    get running() {
      return running;
    },
    stats() {
      return {
        hz,
        ticks,
        skippedTicks: skipped,
        durationP50Ms: percentile(durations, 0.5),
        durationP99Ms: percentile(durations, 0.99),
        durationMaxMs: durations.length ? Math.max(...durations) : 0,
        latenessP50Ms: percentile(lateness, 0.5),
        latenessP99Ms: percentile(lateness, 0.99),
      };
    },
  };
}
