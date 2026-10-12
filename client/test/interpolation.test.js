import assert from "node:assert/strict";
import { test } from "node:test";
import { SNAPSHOT_FLAGS, TICK_MS } from "@fpv/shared";
import {
  SnapshotBuffer,
  lerpAngle,
  wrapDelta,
} from "../src/net/interpolation.js";

const ship = (id, x, y, flags = SNAPSHOT_FLAGS.ACTIVE) => ({
  id,
  kind: "ship",
  x,
  y,
  vx: 0,
  vy: 0,
  angle: 0,
  hp: 100,
  score: 0,
  flags,
});

test("wrapDelta takes the short way around the arena", () => {
  assert.equal(wrapDelta(1590, 10, 1600), 20);
  assert.equal(wrapDelta(10, 1590, 1600), -20);
  assert.equal(wrapDelta(100, 300, 1600), 200);
});

test("lerpAngle crosses zero the short way", () => {
  const mid = lerpAngle(0.1, Math.PI * 2 - 0.1, 0.5);
  assert.ok(Math.abs(mid) < 1e-9 || Math.abs(mid - Math.PI * 2) < 1e-9);
});

test("interpolates between the two snapshots that surround the render time", () => {
  const buffer = new SnapshotBuffer({ delayMs: 100 });
  buffer.push({ tick: 10, ack: 0, entities: [ship(1, 100, 100)] }, 1000);
  buffer.push(
    { tick: 11, ack: 0, entities: [ship(1, 200, 100)] },
    1000 + TICK_MS,
  );
  // offset = 1000 - 10 * TICK_MS; render time = now - offset - 100
  const now = 1000 + 100 + TICK_MS / 2;
  const { entities } = buffer.sample(now);
  assert.ok(Math.abs(entities.get(1).x - 150) < 1e-6);
});

test("the clock offset is the minimum over the window (jitter only adds delay)", () => {
  const buffer = new SnapshotBuffer();
  buffer.push({ tick: 1, ack: 0, entities: [] }, 1000 + 40);
  buffer.push({ tick: 2, ack: 0, entities: [] }, 1000 + TICK_MS * 2 + 5);
  buffer.push({ tick: 3, ack: 0, entities: [] }, 1000 + TICK_MS * 3 + 90);
  assert.ok(Math.abs(buffer.clockOffset - 1005) < 1e-6);
});

test("late or duplicate snapshots are ignored", () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.push({ tick: 5, ack: 0, entities: [] }, 0), true);
  assert.equal(buffer.push({ tick: 5, ack: 0, entities: [] }, 1), false);
  assert.equal(buffer.push({ tick: 4, ack: 0, entities: [] }, 2), false);
  assert.equal(buffer.size, 1);
});

test("a respawning ship is never slid across the arena", () => {
  const buffer = new SnapshotBuffer({ delayMs: 0 });
  buffer.push({ tick: 10, ack: 0, entities: [ship(1, 100, 100, 0)] }, 0);
  buffer.push(
    { tick: 11, ack: 0, entities: [ship(1, 1500, 800, SNAPSHOT_FLAGS.ACTIVE)] },
    TICK_MS,
  );
  const offset = buffer.clockOffset;
  const { entities } = buffer.sample(10 * TICK_MS + TICK_MS * 0.5 + offset);
  assert.equal(entities.get(1).x, 1500);
});

test("past the newest snapshot entities are extrapolated briefly, then held", () => {
  const buffer = new SnapshotBuffer({ delayMs: 0 });
  buffer.push(
    { tick: 1, ack: 0, entities: [{ ...ship(1, 100, 100), vx: 100 }] },
    TICK_MS,
  );
  buffer.push(
    { tick: 2, ack: 0, entities: [{ ...ship(1, 103, 100), vx: 100 }] },
    TICK_MS * 2,
  );
  const base = buffer.clockOffset;
  const soon = buffer.sample(base + 2 * TICK_MS + 50).entities.get(1).x;
  const late = buffer.sample(base + 2 * TICK_MS + 5000).entities.get(1).x;
  assert.ok(Math.abs(soon - 108) < 1e-6);
  assert.ok(Math.abs(late - 118) < 1e-6); // capped at 150 ms
});
