import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import {
  BULLET,
  SIM_STEP,
  TICK_MS,
  asEntityId,
  commandFromBits,
} from "@fpv/shared";
import { GameClient } from "../src/net/gameclient.ts";
import { SnapshotBuffer } from "../src/net/interpolation.ts";
import { PARTICLE_POOL_SIZE, Effects } from "../src/render/effects.ts";
import { ship, snap } from "./fixtures.ts";

describe("allocation-free hot paths keep their behaviour", () => {
  test("a predicted bullet flies along its own velocity (regression: it used to integrate its position)", () => {
    const now = 0;
    const client = new GameClient({
      welcome: {
        shipId: asEntityId(1),
        codec: "json",
        arena: { width: 1600, height: 900 },
      },
      now: () => now,
      send: () => {},
    });
    client.ingest(snap(1, [ship(1, 100, 450)], 0));
    client.step(16); // fire, angle 0 => along +x
    const bullet = client.bullets[0];
    assert.ok(bullet);
    const x0 = bullet.pos.x;
    for (let i = 0; i < 6; i += 1) client.step(0);
    const travelled = (bullet.pos.x - x0 + 1600) % 1600;
    // ~ BULLET.speed * 6 steps (the ship itself does not move: vx = 0).
    assert.ok(
      Math.abs(travelled - BULLET.speed * SIM_STEP * 6) < 1,
      `${travelled}`,
    );
    assert.ok(Math.abs(bullet.pos.y - 450) < 1e-6);
  });

  test("predicted bullets expire after their ttl without reallocating the list", () => {
    const client = new GameClient({
      welcome: { shipId: asEntityId(1), codec: "json" },
      now: () => 0,
      send: () => {},
    });
    client.ingest(snap(1, [ship(1, 100, 100)], 0));
    client.step(16);
    const list = client.bullets;
    for (let i = 0; i < Math.ceil(BULLET.ttl / SIM_STEP) + 2; i += 1)
      client.step(0);
    assert.equal(client.bullets.length, 0);
    assert.equal(client.bullets, list, "same array, compacted in place");
  });

  test("commandFromBits is a table lookup: the same frozen object every time", () => {
    assert.equal(commandFromBits(5), commandFromBits(5));
    assert.ok(Object.isFrozen(commandFromBits(5)));
    assert.equal(
      commandFromBits(5 | 32),
      commandFromBits(5),
      "extra bits are masked off",
    );
  });

  test("view() reuses one WorldView and its arrays between frames", () => {
    let now = 0;
    const client = new GameClient({
      welcome: { shipId: asEntityId(1), codec: "json" },
      now: () => now,
      send: () => {},
    });
    client.ingest(snap(1, [ship(1, 100, 100), ship(2, 300, 300)], 0));
    now += 33;
    client.ingest(snap(2, [ship(1, 100, 100), ship(2, 310, 300)], 0));
    const first = client.view(1, now);
    const ships = first.ships;
    const second = client.view(1, now + 16);
    assert.equal(second, first);
    assert.equal(second.ships, ships);
    assert.equal(second.ships.length, 2);
  });

  test("pooled entries never leak state from a previous frame", () => {
    const buffer = new SnapshotBuffer({ delayMs: 0 });
    buffer.push(snap(1, [ship(1, 10, 10), ship(2, 20, 20)]), TICK_MS);
    buffer.push(snap(2, [ship(1, 11, 10)]), TICK_MS * 2);
    const base = buffer.clockOffset;
    const both = buffer.sample(base + TICK_MS * 1.2);
    assert.equal(both.list.length, 2);
    const alone = buffer.sample(base + TICK_MS * 5);
    assert.deepEqual(
      alone.list.map((e) => e.id),
      [1],
    );
    assert.equal(alone.entities.size, 1);
  });
});

describe("SnapshotBuffer clock offset", () => {
  test("the cached sliding-window minimum equals the naive minimum (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 500, noNaN: true }), {
          minLength: 1,
          maxLength: 80,
        }),
        fc.integer({ min: 1, max: 20 }),
        (delays, windowSize) => {
          const buffer = new SnapshotBuffer({ windowSize });
          const offsets: number[] = [];
          delays.forEach((delay, index) => {
            const tick = index + 1;
            const receivedAt = tick * TICK_MS + delay;
            buffer.push(snap(tick), receivedAt);
            offsets.push(receivedAt - tick * TICK_MS);
            const expected = Math.min(...offsets.slice(-windowSize));
            assert.ok(Math.abs(buffer.clockOffset - expected) < 1e-9);
          });
        },
      ),
    );
  });
});

describe("particle pool", () => {
  test("never grows past its fixed size, however many explosions", () => {
    const effects = new Effects();
    const particles = effects.particles;
    for (let i = 0; i < 200; i += 1) effects.explode(i, i, 28);
    assert.equal(effects.particles, particles);
    assert.equal(effects.particles.length, PARTICLE_POOL_SIZE);
    effects.update(0.016);
    assert.ok(effects.activeCount <= PARTICLE_POOL_SIZE);
  });

  test("particles expire and become reusable", () => {
    const effects = new Effects();
    effects.explode(1, 1, 16);
    effects.update(0.001);
    assert.equal(effects.activeCount, 16);
    for (let i = 0; i < 60; i += 1) effects.update(0.016);
    assert.equal(effects.activeCount, 0);
  });
});
