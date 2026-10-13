import type { NetworkConditions } from "@fpv/shared";
import type { NetStats } from "./gameclient.ts";

/**
 * Turns the cumulative counters of Connection/GameClient into per-second rates
 * and a short history for the netgraph. Pure: the clock is passed in.
 */
export interface Rates {
  downKBps: number;
  upKBps: number;
  snapshotsPerSec: number;
}

export interface NetgraphStats extends NetStats, Rates {
  maxSnapshotGapMs: number;
}

/** The counters the sampler reads; Connection and GameClient provide them. */
interface ByteCounters {
  readonly bytesIn: number;
  readonly bytesOut: number;
}
interface StatsSource {
  readonly stats: { readonly snapshots: number };
  netStats(): NetStats;
}

interface Mark {
  at: number;
  bytesIn: number;
  bytesOut: number;
  snapshots: number;
}

export interface SamplerOptions {
  connection: ByteCounters;
  game: StatsSource;
  historyLength?: number;
}

export class NetStatsSampler {
  readonly connection: ByteCounters;
  readonly game: StatsSource;
  readonly historyLength: number;
  readonly history: { rtt: number[]; snapshotGap: number[] } = {
    rtt: [],
    snapshotGap: [],
  };
  last: Mark | null = null;
  rates: Rates = { downKBps: 0, upKBps: 0, snapshotsPerSec: 0 };
  maxGapMs = 0;
  lastSnapshotAt = 0;

  constructor({ connection, game, historyLength = 120 }: SamplerOptions) {
    this.connection = connection;
    this.game = game;
    this.historyLength = historyLength;
  }

  /** Call every frame with the client clock; rates are refreshed about once per second. */
  sample(now: number): NetgraphStats {
    const stats = this.game.netStats();
    if (stats.lastSnapshotAt !== this.lastSnapshotAt) {
      if (this.lastSnapshotAt) {
        this.maxGapMs = Math.max(
          this.maxGapMs,
          stats.lastSnapshotAt - this.lastSnapshotAt,
        );
        this.#push(
          this.history.snapshotGap,
          stats.lastSnapshotAt - this.lastSnapshotAt,
        );
      }
      this.lastSnapshotAt = stats.lastSnapshotAt;
    }
    if (!this.last) {
      this.last = this.#mark(now);
    } else if (now - this.last.at >= 1000) {
      const seconds = (now - this.last.at) / 1000;
      this.rates = {
        downKBps:
          (this.connection.bytesIn - this.last.bytesIn) / 1024 / seconds,
        upKBps:
          (this.connection.bytesOut - this.last.bytesOut) / 1024 / seconds,
        snapshotsPerSec: (stats.snapshots - this.last.snapshots) / seconds,
      };
      this.#push(this.history.rtt, stats.rttMs);
      this.last = this.#mark(now);
    }
    return { ...stats, ...this.rates, maxSnapshotGapMs: this.maxGapMs };
  }

  #mark(now: number): Mark {
    return {
      at: now,
      bytesIn: this.connection.bytesIn,
      bytesOut: this.connection.bytesOut,
      snapshots: this.game.stats.snapshots,
    };
  }

  #push(list: number[], value: number): void {
    list.push(value);
    if (list.length > this.historyLength) list.shift();
  }
}

export function formatNetgraph(
  s: NetgraphStats,
  { codec, network }: { codec: string; network: NetworkConditions },
): string {
  const sim =
    network.latencyMs || network.jitterMs || network.drop
      ? `sim ${network.latencyMs}±${network.jitterMs} ms, ${(network.drop * 100).toFixed(0)}% loss`
      : "no simulated lag";
  return [
    `codec        ${codec}`,
    `RTT          ${s.rttMs.toFixed(0)} ms`,
    `snapshot age ${s.snapshotAgeMs.toFixed(0)} ms (max gap ${s.maxSnapshotGapMs.toFixed(0)})`,
    `snapshots/s  ${s.snapshotsPerSec.toFixed(1)}`,
    `down / up    ${s.downKBps.toFixed(1)} / ${s.upKBps.toFixed(1)} KB/s`,
    `pending in.  ${s.pendingInputs}`,
    `correction   ${s.correctionPx.toFixed(1)} px (max ${s.maxCorrectionPx.toFixed(1)})`,
    `mispredicts  ${s.mispredictions} / ${s.reconciliations}`,
    `interp delay ${s.interpolationDelayMs} ms`,
    sim,
  ].join("\n");
}
