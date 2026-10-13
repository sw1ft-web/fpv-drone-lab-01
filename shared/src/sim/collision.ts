import type { EntityKind } from "../types.ts";
import type { Bullet } from "./bullet.ts";
import type { Asteroid } from "./asteroid.ts";
import { PICKUP_TYPES, Pickup } from "./pickup.ts";
import type { Ship } from "./ship.ts";
import type { AnyEntity, World } from "./world.ts";

type OfKind<K extends EntityKind> = Extract<AnyEntity, { kind: K }>;

const isKind = <K extends EntityKind>(
  entity: AnyEntity,
  kind: K,
): entity is OfKind<K> => entity.kind === kind;

/** Orders a colliding pair as (first kind, second kind), whichever way round it was found; null if it is another pair. */
function ordered<A extends EntityKind, B extends EntityKind>(
  a: AnyEntity,
  b: AnyEntity,
  first: A,
  second: B,
): [OfKind<A>, OfKind<B>] | null {
  if (isKind(a, first) && isKind(b, second)) return [a, b];
  if (isKind(b, first) && isKind(a, second)) return [b, a];
  return null;
}

export function circleCollisions(world: World): [AnyEntity, AnyEntity][] {
  const entities = [...world];
  const pairs: [AnyEntity, AnyEntity][] = [];

  for (let i = 0; i < entities.length; i += 1) {
    const a = entities[i];
    if (!a?.alive) continue;
    for (let j = i + 1; j < entities.length; j += 1) {
      const b = entities[j];
      if (!b?.alive) continue;
      if (overlaps(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

function overlaps(a: AnyEntity, b: AnyEntity): boolean {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const radius = a.radius + b.radius;
  return dx * dx + dy * dy <= radius * radius;
}

export function resolveCollisions(world: World): void {
  for (const [a, b] of circleCollisions(world)) {
    if (!a.alive || !b.alive) continue;

    const bulletShip = ordered(a, b, "bullet", "ship");
    if (bulletShip) {
      hitShip(...bulletShip, world);
      continue;
    }
    const bulletAsteroid = ordered(a, b, "bullet", "asteroid");
    if (bulletAsteroid) {
      hitAsteroid(...bulletAsteroid, world);
      continue;
    }
    const shipPickup = ordered(a, b, "ship", "pickup");
    if (shipPickup) {
      collectPickup(...shipPickup, world);
      continue;
    }
    const shipAsteroid = ordered(a, b, "ship", "asteroid");
    if (shipAsteroid) {
      const [ship] = shipAsteroid;
      if (ship.takeDamage(20, world)) {
        world.bus.emit("hit", {
          target: "ship",
          shipId: ship.id,
          damage: 20,
          hp: ship.hp,
        });
      }
    }
  }
}

function hitShip(bullet: Bullet, ship: Ship, world: World): void {
  if (bullet.ownerId === ship.id) return; // no friendly fire on yourself
  if (ship.takeDamage(bullet.damage, world)) {
    world.bus.emit("hit", {
      target: "ship",
      shipId: ship.id,
      damage: bullet.damage,
      hp: ship.hp,
    });
    if (ship.hp <= 0) world.addScore(bullet.ownerId, 100, "ship-destroyed");
  }
  bullet.markDead();
}

function hitAsteroid(bullet: Bullet, asteroid: Asteroid, world: World): void {
  asteroid.markDead();
  bullet.markDead();
  world.addScore(bullet.ownerId, 25, "asteroid");
  world.bus.emit("hit", { target: "asteroid", asteroidId: asteroid.id });
  world.bus.emit("exploded", {
    kind: "asteroid",
    id: asteroid.id,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  });

  if (world.rng.chance(0.2)) {
    const type = PICKUP_TYPES[world.rng.int(PICKUP_TYPES.length)] ?? "shield";
    world.spawn(new Pickup({ x: asteroid.pos.x, y: asteroid.pos.y }, type));
  }
}

function collectPickup(ship: Ship, pickup: Pickup, world: World): void {
  pickup.applyTo(ship);
  world.addScore(ship.id, 10, `pickup-${pickup.pickupType}`);
}
