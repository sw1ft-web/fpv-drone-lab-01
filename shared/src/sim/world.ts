import { ARENA_HEIGHT, ARENA_WIDTH, SNAPSHOT_FLAGS } from "../constants.ts";
import { DEFAULT_ARENA, arenaRules } from "../arenas.ts";
import type { ArenaRules } from "../arenas.ts";
import { Bus } from "../bus.ts";
import { createRng } from "../prng.ts";
import type { Rng } from "../prng.ts";
import type { EntityId, EntityView, SequencedCommand } from "../types.ts";
import { Asteroid } from "./asteroid.ts";
import { resolveCollisions } from "./collision.ts";
import { integrateShip } from "./integrate.ts";
import type { IntegrateShip } from "./integrate.ts";
import { PICKUP_TYPES, Pickup } from "./pickup.ts";
import { Ship } from "./ship.ts";
import type { Bullet } from "./bullet.ts";
import { asEntityId } from "../types.ts";

/** Every entity the world can hold. Discriminated by `kind`. */
export type AnyEntity = Ship | Bullet | Asteroid | Pickup;

/** Events the simulation publishes; the name decides the payload type. */
export type GameEvents = {
  fired: { shipId: EntityId; bulletId: EntityId };
  hit:
    | { target: "ship"; shipId: EntityId; damage: number; hp: number }
    | { target: "asteroid"; asteroidId: EntityId };
  exploded: {
    kind: "ship" | "asteroid";
    id: EntityId;
    x: number;
    y: number;
  };
  scoreChanged: {
    shipId: EntityId;
    score: number;
    points: number;
    reason: string;
  };
};

export interface WorldOptions {
  width?: number;
  height?: number;
  seed?: number;
  arenaId?: string;
  /** Replaceable so tests can inject a deliberately broken movement function. */
  integrate?: IntegrateShip;
}

/**
 * The deterministic game world. Same seed + same commands in the same order
 * => bit-identical state, on any machine, with or without a DOM.
 */
export class World {
  readonly #entities = new Map<EntityId, AnyEntity>();
  #nextId = 1;
  readonly bus = new Bus<GameEvents>();
  width: number;
  height: number;
  readonly seed: number;
  readonly rng: Rng;
  readonly rules: ArenaRules;
  readonly integrate: IntegrateShip;
  stepCount = 0;

  constructor({
    width = ARENA_WIDTH,
    height = ARENA_HEIGHT,
    seed = 1,
    arenaId = DEFAULT_ARENA,
    integrate = integrateShip,
  }: WorldOptions = {}) {
    this.width = width;
    this.height = height;
    this.seed = seed >>> 0;
    this.rng = createRng(seed);
    this.rules = arenaRules(arenaId);
    this.integrate = integrate;
  }

  spawn<T extends AnyEntity>(entity: T): T {
    entity.id = asEntityId(this.#nextId++);
    this.#entities.set(entity.id, entity);
    return entity;
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  /** Fills the arena with asteroids and pickups as dictated by the arena rules. */
  populate(): void {
    for (let i = 0; i < this.rules.asteroids; i += 1) this.#spawnAsteroid();
    for (let i = 0; i < this.rules.pickups; i += 1) {
      const type = PICKUP_TYPES[i % PICKUP_TYPES.length] ?? "shield";
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

  addShip(): Ship {
    const margin = 120;
    const ship = new Ship({
      x: this.rng.range(margin, this.width - margin),
      y: this.rng.range(margin, this.height - margin),
    });
    ship.angle = this.rng.range(0, Math.PI * 2);
    ship.invulnerable = 2;
    return this.spawn(ship);
  }

  removeEntity(id: EntityId): void {
    this.#entities.delete(id);
  }

  addScore(shipId: EntityId, points: number, reason = "game"): void {
    const ship = this.#entities.get(shipId);
    if (!ship || ship.kind !== "ship") return;
    ship.score += points;
    this.bus.emit("scoreChanged", {
      shipId,
      score: ship.score,
      points,
      reason,
    });
  }

  *[Symbol.iterator](): IterableIterator<AnyEntity> {
    yield* this.#entities.values();
  }

  /** Ships in insertion order (the same order the generic iterator yields them). */
  *ships(): IterableIterator<Ship> {
    for (const entity of this.#entities.values())
      if (entity.kind === "ship") yield entity;
  }

  *bullets(): IterableIterator<Bullet> {
    for (const entity of this.#entities.values())
      if (entity.kind === "bullet") yield entity;
  }

  *asteroids(): IterableIterator<Asteroid> {
    for (const entity of this.#entities.values())
      if (entity.kind === "asteroid") yield entity;
  }

  /**
   * One fixed simulation step. `commands` maps shipId -> command (a ship with
   * no entry stands still this step).
   */
  step(
    dt: number,
    commands: ReadonlyMap<EntityId, SequencedCommand> = new Map(),
  ): void {
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

  #spawnAsteroid(): Asteroid {
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
  snapshotEntities(): EntityView[] {
    const views: EntityView[] = [];
    for (const entity of this.#entities.values()) {
      const base = {
        id: entity.id,
        x: entity.pos.x,
        y: entity.pos.y,
        vx: entity.vel.x,
        vy: entity.vel.y,
        angle: entity.angle,
      };
      switch (entity.kind) {
        case "ship":
          views.push({
            ...base,
            kind: "ship",
            hp: entity.hp,
            score: entity.score,
            flags:
              (entity.isActive() ? SNAPSHOT_FLAGS.ACTIVE : 0) |
              (entity.invulnerable > 0 ? SNAPSHOT_FLAGS.INVULNERABLE : 0) |
              (entity.shield > 0 ? SNAPSHOT_FLAGS.SHIELD : 0) |
              (entity.rapidFire > 0 ? SNAPSHOT_FLAGS.RAPID_FIRE : 0) |
              (entity.thrust ? SNAPSHOT_FLAGS.THRUST : 0),
          });
          break;
        case "bullet":
          views.push({
            ...base,
            kind: "bullet",
            ownerId: entity.ownerId,
            fireSeq: entity.fireSeq,
          });
          break;
        case "asteroid":
          views.push({
            ...base,
            kind: "asteroid",
            radius: entity.radius,
            homing: entity.homing ? 1 : 0,
          });
          break;
        case "pickup":
          views.push({
            ...base,
            kind: "pickup",
            pickupType: entity.pickupType === "shield" ? 0 : 1,
          });
          break;
        default:
          return assertNeverEntity(entity);
      }
    }
    return views;
  }
}

function assertNeverEntity(entity: never): never {
  throw new Error(`unknown entity ${JSON.stringify(entity)}`);
}
