/**
 * Chaos tests: break things on purpose and show, with numbers, that the damage
 * stays where it was done. Real server, real sockets, real client Connection.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { silentLogger } from "../../server/src/logger.ts";
import { loadConfig } from "../../server/src/config.ts";
import { createApp } from "../../server/src/index.ts";
import type { App } from "../../server/src/index.ts";
import { Connection } from "../../client/src/net/connection.ts";

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {});
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function startApp(port = 0) {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-chaos-"));
  dirs.push(logDir);
  const app = createApp(
    loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      MAX_CONNECTIONS_PER_IP: "1000",
    }),
    { logger: silentLogger },
  );
  const address = await app.listen();
  apps.push(app);
  return { app, port: address.port, url: `ws://127.0.0.1:${address.port}/ws` };
}

/** A raw player that records when each snapshot arrived. */
async function player(url: string, roomId: string, name: string) {
  const socket = new WebSocket(url);
  const arrivals: number[] = [];
  socket.on("message", (data, isBinary) => {
    if (
      !isBinary &&
      (data as Buffer).toString("utf8").includes('"type":"snapshot"')
    )
      arrivals.push(performance.now());
  });
  socket.on("error", () => {});
  await once(socket, "open");
  socket.send(JSON.stringify({ v: 1, type: "join", roomId, name }));
  // keep sending idle inputs so the ship exists in a running match
  let seq = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    seq += 2;
    socket.send(
      JSON.stringify({
        v: 1,
        type: "input",
        inputs: [
          { seq: seq - 1, bits: 4 },
          { seq, bits: 4 },
        ],
      }),
    );
  }, 33);
  return {
    socket,
    arrivals,
    stop: () => clearInterval(timer),
  };
}

/** Longest gap between consecutive snapshots in [from, to]. */
function maxGap(arrivals: number[], from: number, to: number): number {
  const window = arrivals.filter((t) => t >= from && t <= to);
  let gap = 0;
  for (let i = 1; i < window.length; i += 1)
    gap = Math.max(gap, (window[i] ?? 0) - (window[i - 1] ?? 0));
  return gap;
}

const Stats = z.object({
  players: z.number(),
  tick: z.object({ durationP99Ms: z.number() }),
});
const stats = async (app: App) =>
  Stats.parse(
    await (
      await fetch(
        `http://127.0.0.1:${app.server.address() && (app.server.address() as { port: number }).port}/api/stats`,
      )
    ).json(),
  );
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const NOMINAL_GAP_MS = 1000 / 30;

describe("chaos", () => {
  test("clients dropping mid-match (hard TCP termination) do not disturb another room", async () => {
    const { app, url } = await startApp();
    const doomed = await Promise.all(
      ["a1", "a2", "a3", "a4"].map((n) => player(url, "night-run", n)),
    );
    const victims = await Promise.all(
      ["b1", "b2"].map((n) => player(url, "kyiv-alpha", n)),
    );
    await sleep(600);
    const before = await stats(app);
    assert.equal(before.players, 6);

    const t0 = performance.now();
    for (const p of doomed.slice(0, 3)) {
      p.stop();
      p.socket.terminate(); // no close frame: the way a pulled cable looks
    }
    await sleep(1500);
    const t1 = performance.now();

    const after = await stats(app);
    assert.equal(after.players, 3, "the dropped players left their room");
    for (const v of victims) {
      const gap = maxGap(v.arrivals, t0, t1);
      assert.ok(
        gap < NOMINAL_GAP_MS * 3,
        `victim snapshot gap ${gap.toFixed(0)} ms`,
      );
      assert.ok(v.arrivals.filter((t) => t >= t0 && t <= t1).length > 35);
    }
    assert.ok(after.tick.durationP99Ms < NOMINAL_GAP_MS);
    for (const p of [...doomed, ...victims]) {
      p.stop();
      p.socket.terminate();
    }
  });

  test("a server restart: clients reconnect with backoff and rejoin by themselves", async () => {
    const first = await startApp();
    const connection = new Connection({
      url: first.url,
      WebSocketImpl: WebSocket,
      baseMs: 50,
      maxMs: 400,
    });
    connection.setSession({
      v: 1,
      type: "join",
      roomId: "training-01",
      name: "Phoenix",
    } as never);
    let welcomes = 0;
    connection.on("welcome", () => {
      welcomes += 1;
    });
    connection.connect();
    const until = async (predicate: () => boolean, ms: number) => {
      const end = performance.now() + ms;
      while (!predicate()) {
        if (performance.now() > end) throw new Error("timed out");
        await sleep(20);
      }
    };
    await until(() => welcomes === 1, 3000);

    await first.app.close(); // sockets get 1001 + a shutdown message
    await sleep(300); // server is down: the client is retrying
    assert.notEqual(connection.state, "open");

    const second = await startApp(first.port); // same address, fresh process state
    await until(() => welcomes === 2, 6000);
    assert.equal(connection.state, "open");
    assert.equal(second.app.roomManager.get("training-01")?.size, 1);
    connection.close();
  });

  test("a garbage-frame flood from many attackers is cut off and the other room never notices", async () => {
    const { app, url } = await startApp();
    const victim = await player(url, "kyiv-alpha", "victim");
    await sleep(500);
    const t0 = performance.now();

    const attackers = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const socket = new WebSocket(url);
        socket.on("error", () => {});
        await once(socket, "open");
        socket.send(
          JSON.stringify({
            v: 1,
            type: "join",
            roomId: "night-run",
            name: "evil",
          }),
        );
        return socket;
      }),
    );
    const closed = attackers.map(
      (socket) =>
        new Promise<number>((resolve) =>
          socket.once("close", (code: number) => resolve(code)),
        ),
    );
    for (const socket of attackers) {
      for (let i = 0; i < 5000; i += 1) {
        if (socket.readyState !== WebSocket.OPEN) break;
        socket.send(i % 2 ? "\u0000garbage\u0000" : Buffer.alloc(64, 0xff));
      }
      await sleep(0); // the test shares the process with the server; let it breathe
    }
    const codes = await Promise.all(closed);
    await sleep(800);
    const t1 = performance.now();

    assert.ok(
      // 4000 bad message, 4003 rate limited, 4004 room full (the room holds 8).
      codes.every((code) => code === 4003 || code === 4000 || code === 4004),
      `closed with ${codes.join(",")}`,
    );
    const gap = maxGap(victim.arrivals, t0, t1);
    assert.ok(
      gap < NOMINAL_GAP_MS * 8, // server and attackers share one event loop here
      `victim snapshot gap ${gap.toFixed(0)} ms`,
    );
    const after = await stats(app);
    assert.equal(
      after.players,
      1,
      "every attacker is gone, the victim remains",
    );
    assert.ok(after.tick.durationP99Ms < NOMINAL_GAP_MS);

    const text = await (
      await fetch(
        `http://127.0.0.1:${(app.server.address() as { port: number }).port}/metrics`,
      )
    ).text();
    assert.match(
      text,
      /fpv_rejected_total\{reason="(rate_limit|bad_message)"\} [1-9]/,
    );
    victim.stop();
    victim.socket.terminate();
  });
});
