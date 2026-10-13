import { ARENA_HEIGHT, ARENA_WIDTH, SNAPSHOT_FLAGS } from "../constants.js";
import { DEFAULT_ARENA, arenaRules } from "../arenas.js";
import { createRng } from "../prng.js";
import { Asteroid } from "./asteroid.js";
import { resolveCollisions } from "./collision.js";
import { integrateShip } from "./integrate.js";
import { PICKUP_TYPES, Pickup } from "./pickup.js";
import { Ship } from "./ship.js";

/**
 * The deterministic game world. Same seed + same commands in the same order
 * => bit-identical state, on any machine, with or without a DOM.
 *
 * `integrate` can be replaced (tests use it to inject a deliberately broken
 * movement function and watch prediction fall apart).
 */
export class World extends EventTarget {
  #entities = new Map();
  #nextId = 1;

  constructor({
    width = ARENA_WIDTH,
    height = ARENA_HEIGHT,
    seed = 1,
    arenaId = DEFAULT_ARENA,
    integrate = integrateShip,
  } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.seed = seed >>> 0;
    this.rng = createRng(seed);
    this.rules = arenaRules(arenaId);
    this.integrate = integrate;
    this.stepCount = 0;
  }

  spawn(entity) {
    entity.id = this.#nextId++;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  get(id) {
    return this.#entities.get(id);
  }

  /** Fills the arena with asteroids and pickups as dictated by the arena rules. */
  populate() {
    for (let i = 0; i < this.rules.asteroids; i += 1) this.#spawnAsteroid();
    for (let i = 0; i < this.rules.pickups; i += 1) {
      const type = PICKUP_TYPES[i % PICKUP_TYPES.length];
      this.spawn(
        new Pickup(
          {
            x: this.width * (0.3 + i * 0.3),
            y: this.height * (0.35 + (i % 2) * 0.25),
          },
          type,
        ),
      );
    }
    for (let i = 0; i < this.rules.homingAsteroids; i += 1) {
      const asteroid = new Asteroid(
        { x: this.width * 0.8, y: this.height * 0.25 },
        { x: -25, y: 10 },
        30,
      );
      this.spawn(asteroid.makeHoming());
    }
  }

  addShip() {
    const margin = 120;
    const ship = new Ship({
      x: this.rng.range(margin, this.width - margin),
      y: this.rng.range(margin, this.height - margin),
    });
    ship.angle = this.rng.range(0, Math.PI * 2);
    ship.invulnerable = 2;
    return this.spawn(ship);
  }

  removeEntity(id) {
    this.#entities.delete(id);
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(shipId, points, reason = "game") {
    const ship = this.#entities.get(shipId);
    if (!ship || ship.kind !== "ship") return;
    ship.score += points;
    this.emit("scoreChanged", { shipId, score: ship.score, points, reason });
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.kind === kind) yield entity;
    }
  }

  /**
   * One fixed simulation step. `commands` maps shipId -> command (a ship with
   * no entry stands still this step).
   */
  step(dt, commands = new Map()) {
    for (const entity of [...this.#entities.values()]) {
      if (!entity.alive) continue;
      entity.update(dt, this, commands.get(entity.id));
    }
    resolveCollisions(this);
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id);
    }

    let asteroids = 0;
    for (const entity of this.#entities.values())
      if (entity.kind === "asteroid") asteroids += 1;
    if (
      this.rules.asteroids > 0 &&
      asteroids < Math.max(4, this.rules.asteroids - 1)
    )
      this.#spawnAsteroid();

    this.stepCount += 1;
  }

  #spawnAsteroid() {
    const margin = 40;
    const rng = this.rng;
    // Evaluation order is part of the contract: arguments are drawn left to right.
    const x = rng.range(margin, this.width - margin);
    const y = rng.range(margin, this.height - margin);
    const vx = (rng.next() - 0.5) * 90;
    const vy = (rng.next() - 0.5) * 90;
    const radius = 22 + rng.next() * 18;
    const angle = rng.range(0, Math.PI * 2);
    const rotationSpeed = (rng.next() - 0.5) * 1.2;
    return this.spawn(
      new Asteroid({ x, y }, { x: vx, y: vy }, radius, angle, rotationSpeed),
    );
  }

  /** Plain-object description of every entity: this is what the codecs transmit. */
  snapshotEntities() {
    const entities = [];
    for (const entity of this.#entities.values()) {
      const view = {
        id: entity.id,
        kind: entity.kind,
        x: entity.pos.x,
        y: entity.pos.y,
        vx: entity.vel.x,
        vy: entity.vel.y,
        angle: entity.angle,
      };
      if (entity.kind === "ship") {
        view.hp = entity.hp;
        view.score = entity.score;
        view.flags =
          (entity.isActive() ? SNAPSHOT_FLAGS.ACTIVE : 0) |
          (entity.invulnerable > 0 ? SNAPSHOT_FLAGS.INVULNERABLE : 0) |
          (entity.shield > 0 ? SNAPSHOT_FLAGS.SHIELD : 0) |
          (entity.rapidFire > 0 ? SNAPSHOT_FLAGS.RAPID_FIRE : 0) |
          (entity.thrust ? SNAPSHOT_FLAGS.THRUST : 0);
      } else if (entity.kind === "bullet") {
        view.ownerId = entity.ownerId;
        view.fireSeq = entity.fireSeq;
      } else if (entity.kind === "asteroid") {
        view.radius = entity.radius;
        view.homing = entity.homing ? 1 : 0;
      } else if (entity.kind === "pickup") {
        view.pickupType = PICKUP_TYPES.indexOf(entity.pickupType);
      }
      entities.push(view);
    }
    return entities;
  }
}
