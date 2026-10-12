import assert from "node:assert/strict";
import { test } from "node:test";
import { ARENA_HEIGHT, ARENA_WIDTH, SHIP, SIM_STEP } from "../src/constants.ts";
import {
  EMPTY_COMMAND,
  commandFromBits,
  commandToBits,
} from "../src/sim/command.ts";
import { integrateBullet, integrateShip } from "../src/sim/integrate.ts";
import type { ShipKinematic } from "../src/sim/integrate.ts";
import type { Command } from "../src/index.ts";

const makeShip = (overrides: Partial<ShipKinematic> = {}): ShipKinematic => ({
  pos: { x: 800, y: 450 },
  vel: { x: 0, y: 0 },
  angle: 0,
  thrust: 0,
  ...overrides,
});
const step = (ship: ShipKinematic, command: Command, n = 1): ShipKinematic => {
  for (let i = 0; i < n; i += 1)
    integrateShip(ship, command, SIM_STEP, ARENA_WIDTH, ARENA_HEIGHT);
  return ship;
};

test("thrust accelerates along the heading and sets the thrust flag", () => {
  const ship = step(
    makeShip({ angle: 0 }),
    { ...EMPTY_COMMAND, thrust: true },
    30,
  );
  assert.ok(ship.vel.x > 50);
  assert.ok(Math.abs(ship.vel.y) < 1e-9);
  assert.equal(ship.thrust, 1);
  assert.ok(ship.pos.x > 800);
});

test("rotation: right increases the angle, left decreases it, both wrap into [0, 2pi)", () => {
  const right = step(makeShip(), { ...EMPTY_COMMAND, right: true }, 10);
  assert.ok(right.angle > 0 && right.angle < Math.PI);
  const left = step(makeShip(), { ...EMPTY_COMMAND, left: true }, 10);
  assert.ok(left.angle > Math.PI && left.angle < 2 * Math.PI);
});

test("speed never exceeds maxSpeed", () => {
  const ship = step(makeShip(), { ...EMPTY_COMMAND, thrust: true }, 600);
  assert.ok(Math.hypot(ship.vel.x, ship.vel.y) <= SHIP.maxSpeed + 1e-9);
});

test("brake slows the ship faster than drag", () => {
  const coasting = step(makeShip({ vel: { x: 300, y: 0 } }), EMPTY_COMMAND, 30);
  const braking = step(
    makeShip({ vel: { x: 300, y: 0 } }),
    { ...EMPTY_COMMAND, brake: true },
    30,
  );
  assert.ok(braking.vel.x < coasting.vel.x);
});

test("the ship wraps around the arena edges", () => {
  const ship = step(
    makeShip({ pos: { x: ARENA_WIDTH - 1, y: 450 }, vel: { x: 300, y: 0 } }),
    EMPTY_COMMAND,
    5,
  );
  assert.ok(ship.pos.x >= 0 && ship.pos.x < 50);
});

test("integration is a pure function of state, command and dt", () => {
  const script = [4, 5, 5, 1, 0, 6, 2, 4, 20, 4].map(commandFromBits);
  const run = () => {
    const ship = makeShip();
    for (const command of script) step(ship, command, 7);
    return JSON.stringify(ship);
  };
  assert.equal(run(), run());
});

test("command bits round-trip", () => {
  for (let bits = 0; bits < 32; bits += 1)
    assert.equal(commandToBits(commandFromBits(bits)), bits);
});

test("bullets move in a straight line and wrap", () => {
  const bullet = {
    pos: { x: ARENA_WIDTH - 2, y: 5 },
    vel: { x: 600, y: -600 },
  };
  integrateBullet(bullet, SIM_STEP, ARENA_WIDTH, ARENA_HEIGHT);
  assert.ok(bullet.pos.x >= 0 && bullet.pos.x < 20);
  assert.ok(bullet.pos.y > ARENA_HEIGHT - 20);
});
