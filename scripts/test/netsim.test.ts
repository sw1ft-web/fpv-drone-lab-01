import assert from "node:assert/strict";
import { test } from "node:test";
import { integrateShip } from "../../shared/src/index.ts";
import type { IntegrateShip } from "../../shared/src/index.ts";
import { runSession } from "../lib/netsim.ts";

test("deterministic shared integration: prediction never disagrees with the server", () => {
  for (const codec of ["json", "binary"] as const) {
    const r = runSession({ seconds: 15, codec, latencyMs: 100, jitterMs: 25 });
    assert.equal(r.mispredictions, 0, `${codec}: ${r.mispredictions}`);
    assert.ok(r.maxCorrectionPx < 0.5);
  }
});

test("prediction survives packet loss and jitter", () => {
  const r = runSession({
    seconds: 15,
    latencyMs: 150,
    jitterMs: 40,
    drop: 0.15,
  });
  assert.equal(r.mispredictions, 0);
  assert.ok(r.droppedUp > 0 && r.droppedDown > 0);
  assert.ok(r.finalSeq - r.finalAck < 60, "inputs keep being acknowledged");
});

test("Math.random() inside integrate() breaks prediction", () => {
  const noisy: IntegrateShip = (ship, command, dt, w, h) => {
    integrateShip(ship, command, dt, w, h);
    ship.pos.x += (Math.random() - 0.5) * 0.8;
  };
  const r = runSession({
    seconds: 10,
    latencyMs: 80,
    serverIntegrate: noisy,
    clientIntegrate: noisy,
  });
  assert.ok(r.mispredictions > 50, `only ${r.mispredictions} mispredictions`);
});

test("interpolation renders remote ships at their real speed, snapshots-only does not", () => {
  const r = runSession({
    seconds: 20,
    latencyMs: 100,
    jitterMs: 30,
    drop: 0.1,
  });
  assert.ok(r.remoteJumpP99 < 8, `p99=${r.remoteJumpP99}`);
  assert.ok(r.remoteBaselineJumpP99 > r.remoteJumpP99 * 1.5);
});

test("the binary codec is several times smaller than JSON", () => {
  const json = runSession({ seconds: 10, codec: "json" });
  const binary = runSession({ seconds: 10, codec: "binary" });
  assert.ok(json.kbPerSecDown / binary.kbPerSecDown > 4);
  assert.ok(json.kbPerSecUp / binary.kbPerSecUp > 3);
});

test("a run is exactly repeatable", () => {
  const a = runSession({ seconds: 5, latencyMs: 60, jitterMs: 20, drop: 0.05 });
  const b = runSession({ seconds: 5, latencyMs: 60, jitterMs: 20, drop: 0.05 });
  assert.deepEqual(a, b);
});
