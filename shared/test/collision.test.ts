import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  Asteroid,
  BULLET,
  Bullet,
  SIM_STEP,
  Ship,
  World,
  asEntityId,
} from "../src/index.ts";
import { circleCollisions } from "../src/sim/collision.ts";

const emptyWorld = () => new World({ seed: 1, arenaId: "arena-training" });

describe("circle collisions", () => {
  test("finds touching and overlapping pairs, ignores distant ones", () => {
    const world = emptyWorld();
    world.spawn(new Asteroid({ x: 100, y: 100 }, { x: 0, y: 0 }, 30));
    world.spawn(new Asteroid({ x: 160, y: 100 }, { x: 0, y: 0 }, 30)); // exactly touching
    world.spawn(new Asteroid({ x: 600, y: 600 }, { x: 0, y: 0 }, 30));
    assert.equal(circleCollisions(world).length, 1);
  });

  test("dead entities never collide", () => {
    const world = emptyWorld();
    const a = world.spawn(new Asteroid({ x: 10, y: 10 }, { x: 0, y: 0 }, 30));
    world.spawn(new Asteroid({ x: 10, y: 10 }, { x: 0, y: 0 }, 30));
    a.markDead();
    assert.equal(circleCollisions(world).length, 0);
  });

  test("a bullet fired at an asteroid destroys it and scores for the shooter", () => {
    const world = emptyWorld();
    const ship = world.spawn(new Ship({ x: 100, y: 450 }));
    world.spawn(new Asteroid({ x: 400, y: 450 }, { x: 0, y: 0 }, 22));
    world.spawn(
      new Bullet({ x: 380, y: 450 }, { x: BULLET.speed, y: 0 }, ship.id),
    );
    let exploded = 0;
    world.bus.on("exploded", () => (exploded += 1));
    for (let i = 0; i < 10; i += 1) world.step(SIM_STEP);
    assert.equal(exploded, 1);
    assert.ok(ship.score > 0);
  });

  test("a bullet never damages the ship that fired it", () => {
    const world = emptyWorld();
    const ship = world.spawn(new Ship({ x: 100, y: 100 }));
    ship.invulnerable = 0;
    world.spawn(new Bullet({ x: 100, y: 100 }, { x: 0, y: 0 }, ship.id));
    world.step(SIM_STEP);
    assert.equal(ship.hp, 100);
  });

  test("a bullet from another ship hurts", () => {
    const world = emptyWorld();
    const ship = world.spawn(new Ship({ x: 100, y: 100 }));
    ship.invulnerable = 0;
    world.spawn(
      new Bullet({ x: 100, y: 100 }, { x: 0, y: 0 }, asEntityId(999)),
    );
    world.step(SIM_STEP);
    assert.ok(ship.hp < 100);
  });

  test("game-speed bullets cannot tunnel through any asteroid", () => {
    // Step length at BULLET.speed is ~10.7 px; the smallest asteroid has radius 22.
    assert.ok(BULLET.speed * SIM_STEP < 22 + BULLET.radius);
  });

  test("KNOWN LIMITATION: a bullet 6x faster than the game's would tunnel (discrete detection)", () => {
    const world = emptyWorld();
    world.spawn(new Asteroid({ x: 400, y: 450 }, { x: 0, y: 0 }, 22));
    const bullet = world.spawn(
      new Bullet({ x: 300, y: 450 }, { x: BULLET.speed * 6, y: 0 }),
    );
    let hits = 0;
    world.bus.on("hit", () => (hits += 1));
    for (let i = 0; i < 4; i += 1) world.step(SIM_STEP);
    assert.equal(hits, 0, "swept collision is not implemented on purpose");
    assert.ok(bullet.pos.x > 460, "the bullet flew past the asteroid");
  });
});
