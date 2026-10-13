import assert from "node:assert/strict";
import { test } from "vitest";
import { SNAPSHOT_FLAGS, TICK_MS, asEntityId } from "@fpv/shared";
import type { EntityId, EntityView } from "@fpv/shared";
import { ship, snap } from "./fixtures.ts";

/** The x of an entity that must be present in a sample. */
const xOf = (entities: Map<EntityId, EntityView>, id: number): number => {
  const entity = entities.get(asEntityId(id));
  assert.ok(entity, `entity ${id} missing`);
  return entity.x;
};
import {
  SnapshotBuffer,
  lerpAngle,
  wrapDelta,
} from "../src/net/interpolation.ts";

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
  buffer.push(snap(10, [ship(1, 100, 100)]), 1000);
  buffer.push(snap(11, [ship(1, 200, 100)]), 1000 + TICK_MS);
  // offset = 1000 - 10 * TICK_MS; render time = now - offset - 100
  const now = 1000 + 100 + TICK_MS / 2;
  const { entities } = buffer.sample(now);
  assert.ok(Math.abs(xOf(entities, 1) - 150) < 1e-6);
});

test("the clock offset is the minimum over the window (jitter only adds delay)", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snap(1), 1000 + 40);
  buffer.push(snap(2), 1000 + TICK_MS * 2 + 5);
  buffer.push(snap(3), 1000 + TICK_MS * 3 + 90);
  assert.ok(Math.abs(buffer.clockOffset - 1005) < 1e-6);
});

test("late or duplicate snapshots are ignored", () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.push(snap(5), 0), true);
  assert.equal(buffer.push(snap(5), 1), false);
  assert.equal(buffer.push(snap(4), 2), false);
  assert.equal(buffer.size, 1);
});

test("a respawning ship is never slid across the arena", () => {
  const buffer = new SnapshotBuffer({ delayMs: 0 });
  buffer.push(snap(10, [ship(1, 100, 100, 0)]), 0);
  buffer.push(snap(11, [ship(1, 1500, 800, SNAPSHOT_FLAGS.ACTIVE)]), TICK_MS);
  const offset = buffer.clockOffset;
  const { entities } = buffer.sample(10 * TICK_MS + TICK_MS * 0.5 + offset);
  assert.equal(xOf(entities, 1), 1500);
});

test("past the newest snapshot entities are extrapolated briefly, then held", () => {
  const buffer = new SnapshotBuffer({ delayMs: 0 });
  buffer.push(snap(1, [{ ...ship(1, 100, 100), vx: 100 }]), TICK_MS);
  buffer.push(snap(2, [{ ...ship(1, 103, 100), vx: 100 }]), TICK_MS * 2);
  const base = buffer.clockOffset;
  const soon = xOf(buffer.sample(base + 2 * TICK_MS + 50).entities, 1);
  const late = xOf(buffer.sample(base + 2 * TICK_MS + 5000).entities, 1);
  assert.ok(Math.abs(soon - 108) < 1e-6);
  assert.ok(Math.abs(late - 118) < 1e-6); // capped at 150 ms
});
