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
export function createTicker({
  hz,
  onTick,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  setImmediateFn = (fn) => setImmediate(fn),
  spinMs = 2,
  maxCatchUpTicks = 4,
  window = 600,
}) {
  const interval = 1000 / hz;
  const durations = [];
  const lateness = [];
  let next = 0;
  let timer = null;
  let running = false;
  let ticks = 0;
  let skipped = 0;

  const push = (list, value) => {
    list.push(value);
    if (list.length > window) list.shift();
  };

  const percentile = (list, q) => {
    if (list.length === 0) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };

  function arm() {
    if (!running) return;
    timer = setTimer(wake, Math.max(0, next - now() - spinMs));
  }

  function wake() {
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
      if (timer !== null) clearTimer(timer);
      timer = null;
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
