/**
 * Allocation-free timing spans for the hot paths (simulate, render, decode,
 * reconcile) plus frame-time samples.
 *
 * Each span writes into a preallocated ring of Float64Array, so measuring does
 * not create the garbage it is meant to find. Pass `?perf=trace` (or call
 * `labPerf.trace(true)`) to additionally emit real `performance.measure()`
 * entries, which show up on the DevTools Performance "Timings" track; those DO
 * allocate, so they are off by default.
 */
export const SPANS = [
  "simulate",
  "render",
  "draw",
  "decode",
  "reconcile",
] as const;
export type SpanName = (typeof SPANS)[number];

const RING = 4096;
const rings = new Map<string, { data: Float64Array; count: number }>();
for (const name of [...SPANS, "frame"])
  rings.set(name, { data: new Float64Array(RING), count: 0 });

let tracing = false;

/** Starts a span; returns the start time to hand back to `end`. */
export function begin(): number {
  return performance.now();
}

export function end(name: SpanName, start: number): void {
  const finish = performance.now();
  record(name, finish - start);
  if (tracing) performance.measure(`fpv:${name}`, { start, end: finish });
}

/** Records one frame-to-frame time (what the player experiences as smoothness). */
export function recordFrame(ms: number): void {
  record("frame", ms);
}

function record(name: string, value: number): void {
  const ring = rings.get(name);
  if (!ring) return;
  ring.data[ring.count % RING] = value;
  ring.count += 1;
}

export interface SpanSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  totalMs: number;
}

function summarize(name: string): SpanSummary {
  const ring = rings.get(name);
  if (!ring || ring.count === 0)
    return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, totalMs: 0 };
  const size = Math.min(ring.count, RING);
  const sorted = Float64Array.from(ring.data.subarray(0, size)).sort();
  const at = (q: number): number =>
    sorted[Math.min(size - 1, Math.floor(q * size))] ?? 0;
  let total = 0;
  for (let i = 0; i < size; i += 1) total += sorted[i] ?? 0;
  return {
    count: ring.count,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[size - 1] ?? 0,
    totalMs: total,
  };
}

export function report(): Record<string, SpanSummary> {
  return Object.fromEntries(
    [...rings.keys()].map((name) => [name, summarize(name)]),
  );
}

export function reset(): void {
  for (const ring of rings.values()) ring.count = 0;
}

export function trace(on: boolean): void {
  tracing = on;
}

/** Console/automation hook: `labPerf.report()` returns p50/p95/p99 for every span. */
export const labPerf = { report, reset, trace };

if (typeof location !== "undefined" && location.search.includes("perf=trace"))
  tracing = true;
