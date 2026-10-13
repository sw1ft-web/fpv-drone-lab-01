import { performance as perfHooks } from "node:perf_hooks";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { MatchManager } from "./matches.ts";
import type { RoomManager } from "./rooms.ts";
import type { Stats } from "./ws.ts";

export interface MetricsOptions {
  roomManager: RoomManager;
  matches: MatchManager;
  stats: Stats;
  version: string;
  sha: string;
}

export interface Metrics {
  readonly registry: Registry;
  /** Counts a refused connection or closed-for-cause socket, labelled by why. */
  rejected(reason: string): void;
  render(): Promise<string>;
}

/**
 * Prometheus metrics. Gauges read live state when scraped (`collect`); counters
 * that already exist as plain numbers in `Stats` are mirrored by adding the
 * difference since the last scrape, so the hot paths stay untouched.
 */
export function createMetrics({
  roomManager,
  matches,
  stats,
  version,
  sha,
}: MetricsOptions): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "fpv_" });

  new Gauge({
    name: "fpv_build_info",
    help: "Build identity; value is always 1.",
    labelNames: ["version", "sha"],
    registers: [registry],
  }).set({ version, sha }, 1);

  const gauge = (name: string, help: string, read: () => number): void => {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read());
      },
    });
  };
  gauge(
    "fpv_players",
    "Players currently in rooms.",
    () => roomManager.playerCount,
  );
  gauge(
    "fpv_connections",
    "Open WebSocket connections.",
    () => stats.connections,
  );
  gauge("fpv_rooms", "Rooms that exist.", () => roomManager.size);
  gauge(
    "fpv_matches",
    "Matches being simulated.",
    () => matches.stats().matches,
  );
  gauge(
    "fpv_tick_duration_p50_seconds",
    "Server tick duration, median of the last 600 ticks.",
    () => matches.stats().tick.durationP50Ms / 1000,
  );
  gauge(
    "fpv_tick_duration_p99_seconds",
    "Server tick duration, p99 of the last 600 ticks (budget: 0.0333).",
    () => matches.stats().tick.durationP99Ms / 1000,
  );
  gauge(
    "fpv_tick_lateness_p99_seconds",
    "How late ticks start, p99 of the last 600 ticks.",
    () => matches.stats().tick.latenessP99Ms / 1000,
  );

  // Event-loop utilization over the interval since the previous scrape.
  let lastElu = perfHooks.eventLoopUtilization();
  gauge(
    "fpv_event_loop_utilization_ratio",
    "Share of time the event loop was busy since the previous scrape (0..1).",
    () => {
      const value = perfHooks.eventLoopUtilization(lastElu).utilization;
      lastElu = perfHooks.eventLoopUtilization();
      return value;
    },
  );

  const mirror = (name: string, help: string, read: () => number): void => {
    let last = 0;
    new Counter({
      name,
      help,
      registers: [registry],
      collect() {
        const now = read();
        this.inc(Math.max(0, now - last));
        last = now;
      },
    });
  };
  mirror(
    "fpv_messages_in_total",
    "WebSocket messages received.",
    () => stats.messagesIn,
  );
  mirror(
    "fpv_bytes_in_total",
    "WebSocket bytes received.",
    () => stats.bytesIn,
  );
  mirror("fpv_bytes_out_total", "WebSocket bytes sent.", () => stats.bytesOut);
  mirror(
    "fpv_snapshots_sent_total",
    "Snapshots delivered to clients.",
    () => stats.snapshotsSent,
  );
  mirror(
    "fpv_inputs_in_total",
    "Player inputs received.",
    () => stats.inputsIn,
  );

  const rejected = new Counter({
    name: "fpv_rejected_total",
    help: "Connections refused or closed for cause, by reason.",
    labelNames: ["reason"],
    registers: [registry],
  });

  return {
    registry,
    rejected: (reason) => rejected.inc({ reason }),
    render: () => registry.metrics(),
  };
}
