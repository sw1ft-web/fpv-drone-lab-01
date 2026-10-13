import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "vitest";
import WebSocket from "ws";
import { STEPS_PER_TICK, asSeq, binaryCodec } from "@fpv/shared";
import type { Snapshot } from "@fpv/shared";
import { z } from "zod";
import { rawToText } from "../src/protocol.ts";
import { Match } from "../src/match.ts";
import { createTicker } from "../src/ticker.ts";
import { connect, startTestServer } from "./helpers.ts";

describe("Match", () => {
  it("applies queued inputs, acks the last applied one and never invents inputs", () => {
    const snapshots: [string, Snapshot][] = [];
    const match = new Match({
      arenaId: "arena-training",
      seed: 1,
      onSnapshot: (id, s) => snapshots.push([id, s]),
    });
    const shipId = match.addPlayer("p1");
    assert.equal(match.shipIdOf("p1"), shipId);
    match.receiveInputs("p1", [
      { seq: asSeq(1), bits: 0 },
      { seq: asSeq(2), bits: 0 },
      { seq: asSeq(3), bits: 0 },
    ]);
    match.tick();
    assert.equal(snapshots.at(-1)?.[1].ack, STEPS_PER_TICK);
    match.tick();
    assert.equal(snapshots.at(-1)?.[1].ack, 3);
    assert.equal(match.starvedSteps, 1);
    assert.equal(snapshots.length, 2);
  });

  it("ignores resent (already seen) inputs", () => {
    const match = new Match({ arenaId: "arena-training", seed: 1 });
    match.addPlayer("p1");
    assert.equal(match.receiveInputs("p1", [{ seq: asSeq(1), bits: 0 }]), 1);
    assert.equal(
      match.receiveInputs("p1", [
        { seq: asSeq(1), bits: 0 },
        { seq: asSeq(2), bits: 0 },
      ]),
      1,
    );
    assert.equal(match.staleInputs, 1);
  });

  it("bounds the per-player queue", () => {
    const match = new Match({
      arenaId: "arena-training",
      seed: 1,
      maxQueue: 3,
    });
    match.addPlayer("p1");
    match.receiveInputs(
      "p1",
      Array.from({ length: 6 }, (_, i) => ({ seq: asSeq(i + 1), bits: 0 })),
    );
    assert.equal(match.droppedInputs, 3);
  });

  it("is deterministic for the same seed and inputs", () => {
    const run = () => {
      let last: Snapshot | undefined;
      const m = new Match({
        arenaId: "arena-training",
        seed: 7,
        onSnapshot: (_id, s) => {
          last = s;
        },
      });
      m.addPlayer("p");
      for (let i = 0; i < 20; i += 1) {
        m.receiveInputs("p", [
          { seq: asSeq(2 * i + 1), bits: 1 },
          { seq: asSeq(2 * i + 2), bits: 5 },
        ]);
        m.tick();
      }
      return JSON.stringify(last);
    };
    assert.equal(run(), run());
  });
});

describe("createTicker", () => {
  it("fires on absolute deadlines on a virtual clock", () => {
    let t = 0;
    const timers: { fn: () => void; at: number }[] = [];
    let ticks = 0;
    const ticker = createTicker({
      hz: 30,
      onTick: () => (ticks += 1),
      now: () => t,
      setTimer: (fn, ms) => {
        const timer = { fn, at: t + ms };
        timers.push(timer);
        return () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
        };
      },
      setImmediateFn: (fn) => {
        timers.push({ fn, at: t + 0.5 });
      },
    });
    ticker.start();
    for (let guard = 0; guard < 20000 && t < 1000; guard += 1) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) break;
      t = Math.max(t, next.at);
      next.fn();
    }
    ticker.stop();
    assert.ok(ticks >= 29 && ticks <= 31, `ticks=${ticks}`);
  });
});

describe("MatchManager over WebSocket", () => {
  it("streams JSON snapshots and acks inputs", async () => {
    const server = await startTestServer();
    try {
      const c = await connect(server.wsUrl);
      c.send({ type: "join", roomId: "training-01", name: "Ann" });
      const welcome = await c.waitForType("welcome");
      assert.equal(welcome.codec, "json");
      assert.ok(Number.isInteger(welcome.shipId));
      c.send({
        type: "input",
        inputs: [
          { seq: 1, bits: 1 },
          { seq: 2, bits: 1 },
        ],
      });
      const snap = await c.waitFor(
        (m) => m.type === "snapshot" && m.ack >= 2,
        3000,
      );
      assert.ok(
        snap.type === "snapshot" &&
          snap.entities.some((e) => e.id === welcome.shipId),
      );
      c.socket.close();
    } finally {
      await server.stop();
    }
  });

  it("streams binary snapshots when the client asks for the binary codec", async () => {
    const server = await startTestServer();
    try {
      const socket = new WebSocket(server.wsUrl);
      socket.binaryType = "arraybuffer";
      await once(socket, "open");
      const frames: Uint8Array[] = [];
      let welcome: { codec: string; shipId: number } | undefined;
      const Welcome = z.object({
        type: z.literal("welcome"),
        codec: z.string(),
        shipId: z.number(),
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          frames.push(
            new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data),
          );
        } else {
          const parsed = Welcome.safeParse(JSON.parse(rawToText(data)));
          if (parsed.success) welcome = parsed.data;
        }
      });
      socket.send(
        JSON.stringify({
          v: 1,
          type: "join",
          roomId: "training-01",
          name: "Bo",
          codec: "binary",
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(welcome?.codec, "binary");
      socket.send(
        binaryCodec.encodeInput({ inputs: [{ seq: asSeq(1), bits: 0 }] }),
      );
      await new Promise((r) => setTimeout(r, 250));
      assert.ok(frames.length >= 2, `frames=${frames.length}`);
      const lastFrame = frames.at(-1);
      assert.ok(lastFrame && welcome);
      const decoded = binaryCodec.decodeSnapshot(lastFrame);
      assert.ok(decoded.ack >= 1);
      const { shipId } = welcome;
      assert.ok(decoded.entities.some((e) => e.id === shipId));
      socket.close();
    } finally {
      await server.stop();
    }
  });

  it("drops the match when the room empties", async () => {
    const server = await startTestServer();
    try {
      const c = await connect(server.wsUrl);
      c.send({ type: "join", roomId: "training-01", name: "Cy" });
      await c.waitForType("welcome");
      assert.ok(server.app.matches.get("training-01"));
      c.socket.close();
      await c.waitForClose();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(server.app.matches.get("training-01"), undefined);
    } finally {
      await server.stop();
    }
  });
});
