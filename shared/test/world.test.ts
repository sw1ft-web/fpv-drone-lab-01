import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import {
  Bullet,
  World,
  asSeq,
  commandFromBits,
  hashWorld,
} from "../src/index.ts";
import type { GameEvents } from "../src/index.ts";
import { runScriptedSim } from "./fixtures/scripted-sim.ts";

// Update only when gameplay is changed on purpose: this pins the simulation's exact behaviour.
const GOLDEN_HASH = 2725481169;

test("same seed + same commands => identical world", () => {
  assert.equal(
    runScriptedSim({ seed: 42 }).hash,
    runScriptedSim({ seed: 42 }).hash,
  );
});

test("a different seed gives a different world", () => {
  assert.notEqual(
    runScriptedSim({ seed: 42 }).hash,
    runScriptedSim({ seed: 43 }).hash,
  );
});

test("golden hash: the scripted simulation did not change behaviour", () => {
  assert.equal(runScriptedSim({ seed: 1234, steps: 1800 }).hash, GOLDEN_HASH);
});

test("the simulation runs in a separate isolate without DOM and gives the same hash", async () => {
  const worker = new Worker(new URL("./fixtures/worker.ts", import.meta.url), {
    workerData: { seed: 1234, steps: 1800 },
  });
  const result = await new Promise<{ hash: number; hasDom: boolean }>(
    (resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    },
  );
  assert.equal(result.hasDom, false);
  assert.equal(result.hash, GOLDEN_HASH);
});

test("Math.random is never called by the simulation", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random() called inside the simulation");
  };
  try {
    runScriptedSim({ seed: 5, steps: 600 });
  } finally {
    Math.random = original;
  }
});

test("a ship without a command for a step does not move", () => {
  const world = new World({ seed: 1 });
  const ship = world.addShip();
  const before = { x: ship.pos.x, y: ship.pos.y };
  world.step(1 / 60, new Map());
  assert.deepEqual({ x: ship.pos.x, y: ship.pos.y }, before);
  world.step(
    1 / 60,
    new Map([[ship.id, { ...commandFromBits(4), seq: asSeq(1) }]]),
  );
  assert.notDeepEqual({ x: ship.pos.x, y: ship.pos.y }, before);
});

test("firing spawns a bullet owned by the ship and tagged with the input seq", () => {
  const world = new World({ seed: 1, arenaId: "none" });
  const ship = world.addShip();
  ship.invulnerable = 0;
  const fired: GameEvents["fired"][] = [];
  world.bus.on("fired", (payload) => fired.push(payload));
  world.step(
    1 / 60,
    new Map([[ship.id, { ...commandFromBits(16), seq: asSeq(77) }]]),
  );
  const bullets = [...world.bullets()];
  assert.equal(bullets.length, 1);
  const [bullet] = bullets;
  assert.ok(bullet);
  assert.equal(bullet.ownerId, ship.id);
  assert.equal(bullet.fireSeq, 77);
  assert.equal(fired.length, 1);
  // cooldown: an immediate second shot is refused
  world.step(
    1 / 60,
    new Map([[ship.id, { ...commandFromBits(16), seq: asSeq(78) }]]),
  );
  assert.equal([...world.bullets()].length, 1);
});

test("a bullet never hurts its owner", () => {
  const world = new World({ seed: 1, arenaId: "none" });
  const ship = world.addShip();
  ship.invulnerable = 0;
  world.spawn(new Bullet({ ...ship.pos }, { x: 0, y: 0 }, ship.id, asSeq(1)));
  world.step(1 / 60);
  assert.equal(ship.hp, 100);
});

test("a bullet damages another ship and the shooter scores when it is destroyed", () => {
  const world = new World({ seed: 1, arenaId: "none" });
  const shooter = world.addShip();
  const target = world.addShip();
  target.invulnerable = 0;
  target.pos.x = 300;
  target.pos.y = 300;
  target.hp = 25;
  world.spawn(
    new Bullet({ x: 300, y: 300 }, { x: 0, y: 0 }, shooter.id, asSeq(1)),
  );
  world.step(1 / 60);
  assert.equal(target.hp, 0);
  assert.equal(target.isActive(), false);
  assert.equal(shooter.score, 100);
});

test("a destroyed ship respawns after the respawn time, at a position drawn from the world rng", () => {
  const world = new World({ seed: 9, arenaId: "none" });
  const ship = world.addShip();
  ship.invulnerable = 0;
  ship.destroy(world);
  for (let i = 0; i < 125; i += 1) world.step(1 / 60);
  assert.equal(ship.isActive(), true);
  assert.equal(ship.hp, 100);
  assert.ok(ship.invulnerable > 0);
});

test("snapshotEntities describes every entity with the fields the codecs need", () => {
  const world = new World({ seed: 3 });
  world.populate();
  world.addShip();
  const entities = world.snapshotEntities();
  const kinds = new Set(entities.map((entity) => entity.kind));
  assert.deepEqual([...kinds].sort(), ["asteroid", "pickup", "ship"]);
  const ship = entities.find((entity) => entity.kind === "ship");
  assert.ok(ship?.kind === "ship");
  assert.ok(Number.isInteger(ship.flags) && ship.hp === 100);
  assert.equal(hashWorld(world), hashWorld(world));
});

test("asteroids are replenished when destroyed", () => {
  const world = new World({ seed: 3 });
  world.populate();
  const count = () => [...world.asteroids()].length;
  const before = count();
  for (const asteroid of [...world.asteroids()].slice(0, 5))
    asteroid.markDead();
  world.step(1 / 60);
  assert.ok(count() < before);
  for (let i = 0; i < 10; i += 1) world.step(1 / 60);
  assert.ok(count() >= 4);
});
