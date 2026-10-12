/**
 * Turns the cumulative counters of Connection/GameClient into per-second rates
 * and a short history for the netgraph. Pure: the clock is passed in.
 */
export class NetStatsSampler {
  constructor({ connection, game, historyLength = 120 }) {
    this.connection = connection;
    this.game = game;
    this.historyLength = historyLength;
    this.history = { rtt: [], snapshotGap: [] };
    this.last = null;
    this.rates = { downKBps: 0, upKBps: 0, snapshotsPerSec: 0 };
    this.maxGapMs = 0;
    this.lastSnapshotAt = 0;
  }

  /** Call every frame with the client clock; rates are refreshed about once per second. */
  sample(now) {
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

  #mark(now) {
    return {
      at: now,
      bytesIn: this.connection.bytesIn,
      bytesOut: this.connection.bytesOut,
      snapshots: this.game.stats.snapshots,
    };
  }

  #push(list, value) {
    list.push(value);
    if (list.length > this.historyLength) list.shift();
  }
}

export function formatNetgraph(s, { codec, network }) {
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
