import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../../server/src/config.js";
import { createApp } from "../../server/src/index.js";
import { GameClient } from "../../client/src/net/gameclient.js";
import { joinRoom } from "../../client/src/net/session.js";

const quiet = { info() {}, warn() {}, error() {} };

/** A real server, a real WebSocket, the real client netcode, driven at 60 Hz in real time. */
async function play({ codec, network = {}, ms = 2500 }) {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-e2e-"));
  const app = createApp(
    loadConfig({ PORT: "0", HOST: "127.0.0.1", LOG_DIR: logDir }),
    { logger: quiet },
  );
  const { port } = await app.listen();
  try {
    const { connection, welcome } = await joinRoom({
      roomId: "training-01",
      name: "E2E",
      codec,
      network,
      url: `ws://127.0.0.1:${port}/ws`,
      WebSocketImpl: WebSocket,
    });
    const game = new GameClient({ connection, welcome });
    let bits = 0;
    const timer = setInterval(() => {
      bits = (bits + 1) % 40 === 0 ? 4 | 16 : 4 | (Math.random() < 0.5 ? 1 : 2);
      game.step(bits);
    }, 1000 / 60);
    await new Promise((resolve) => setTimeout(resolve, ms));
    clearInterval(timer);
    const result = {
      stats: game.netStats(),
      ack: game.ack,
      sent: game.nextSeq - 1,
      welcome,
      bytesIn: connection.bytesIn,
    };
    connection.close();
    game.destroy();
    return result;
  } finally {
    await app.close();
    await rm(logDir, { recursive: true, force: true });
  }
}

for (const codec of ["json", "binary"]) {
  test(`end to end over a real WebSocket (${codec}): snapshots, acks, no misprediction`, async () => {
    const r = await play({ codec });
    assert.equal(r.welcome.codec, codec);
    assert.ok(r.stats.snapshots > 40, `snapshots=${r.stats.snapshots}`);
    assert.ok(r.ack > 100, `ack=${r.ack}`);
    assert.equal(r.stats.badFrames, 0);
    assert.ok(
      r.stats.maxCorrectionPx < 2,
      `correction ${r.stats.maxCorrectionPx}`,
    );
    assert.ok(r.sent - r.ack < 30);
  });
}

test("end to end with 80 ms of simulated lag and 5% loss", async () => {
  const r = await play({
    codec: "binary",
    network: { latencyMs: 80, jitterMs: 20, drop: 0.05 },
    ms: 3000,
  });
  assert.ok(r.stats.snapshots > 30);
  assert.ok(r.stats.rttMs > 120, `rtt=${r.stats.rttMs}`);
  assert.ok(r.stats.maxCorrectionPx < 2);
});
