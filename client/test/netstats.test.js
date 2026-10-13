import assert from "node:assert/strict";
import { test } from "node:test";
import { NetStatsSampler, formatNetgraph } from "../src/net/netstats.js";

test("turns cumulative counters into per-second rates", () => {
  const connection = { bytesIn: 0, bytesOut: 0 };
  const game = {
    stats: { snapshots: 0 },
    netStats: () => ({
      rttMs: 50,
      snapshots: game.stats.snapshots,
      lastSnapshotAt: game.stats.snapshots * 33,
      pendingInputs: 3,
      snapshotAgeMs: 10,
      correctionPx: 0,
      maxCorrectionPx: 0,
      mispredictions: 0,
      reconciliations: 0,
      interpolationDelayMs: 100,
    }),
  };
  const sampler = new NetStatsSampler({ connection, game });
  sampler.sample(0);
  connection.bytesIn = 20 * 1024;
  connection.bytesOut = 2 * 1024;
  game.stats.snapshots = 30;
  const stats = sampler.sample(1000);
  assert.equal(stats.downKBps, 20);
  assert.equal(stats.upKBps, 2);
  assert.equal(stats.snapshotsPerSec, 30);
  assert.equal(sampler.history.rtt.length, 1);
});

test("the netgraph text mentions the simulated network", () => {
  const text = formatNetgraph(
    {
      rttMs: 120,
      snapshotAgeMs: 20,
      maxSnapshotGapMs: 90,
      snapshotsPerSec: 30,
      downKBps: 13,
      upKBps: 1,
      pendingInputs: 4,
      correctionPx: 0,
      maxCorrectionPx: 1,
      mispredictions: 0,
      reconciliations: 10,
      interpolationDelayMs: 100,
    },
    { codec: "binary", network: { latencyMs: 80, jitterMs: 10, drop: 0.05 } },
  );
  assert.match(text, /sim 80±10 ms, 5% loss/);
  assert.match(text, /RTT\s+120 ms/);
});
