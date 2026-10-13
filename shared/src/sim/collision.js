import { PICKUP_TYPES, Pickup } from "./pickup.js";

export function circleCollisions(world) {
  const entities = [...world];
  const pairs = [];

  for (let i = 0; i < entities.length; i += 1) {
    const a = entities[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < entities.length; j += 1) {
      const b = entities[j];
      if (!b.alive) continue;
      if (overlaps(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

function overlaps(a, b) {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const radius = a.radius + b.radius;
  return dx * dx + dy * dy <= radius * radius;
}

export function resolveCollisions(world) {
  for (const [a, b] of circleCollisions(world)) {
    if (!a.alive || !b.alive) continue;

    if (isPair(a, b, "bullet", "ship")) hitShip(a, b, world);
    else if (isPair(a, b, "bullet", "asteroid")) hitAsteroid(a, b, world);
    else if (isPair(a, b, "ship", "pickup")) collectPickup(a, b, world);
    else if (isPair(a, b, "ship", "asteroid")) {
      const ship = a.kind === "ship" ? a : b;
      if (ship.takeDamage(20, world)) {
        world.emit("hit", {
          target: "ship",
          shipId: ship.id,
          damage: 20,
          hp: ship.hp,
        });
      }
    }
  }
}

function isPair(a, b, first, second) {
  return (
    (a.kind === first && b.kind === second) ||
    (a.kind === second && b.kind === first)
  );
}

function hitShip(a, b, world) {
  const bullet = a.kind === "bullet" ? a : b;
  const ship = a.kind === "ship" ? a : b;
  if (bullet.ownerId === ship.id) return; // no friendly fire on yourself
  if (ship.takeDamage(bullet.damage, world)) {
    world.emit("hit", {
      target: "ship",
      shipId: ship.id,
      damage: bullet.damage,
      hp: ship.hp,
    });
    if (ship.hp <= 0) world.addScore(bullet.ownerId, 100, "ship-destroyed");
  }
  bullet.markDead();
}

function hitAsteroid(a, b, world) {
  const bullet = a.kind === "bullet" ? a : b;
  const asteroid = a.kind === "asteroid" ? a : b;
  asteroid.markDead();
  bullet.markDead();
  world.addScore(bullet.ownerId, 25, "asteroid");
  world.emit("hit", { target: "asteroid", asteroidId: asteroid.id });
  world.emit("exploded", {
    kind: "asteroid",
    id: asteroid.id,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  });

  if (world.rng.chance(0.2)) {
    const type = PICKUP_TYPES[world.rng.int(PICKUP_TYPES.length)];
    world.spawn(new Pickup({ x: asteroid.pos.x, y: asteroid.pos.y }, type));
  }
}

function collectPickup(a, b, world) {
  const ship = a.kind === "ship" ? a : b;
  const pickup = a.kind === "pickup" ? a : b;
  pickup.applyTo(ship);
  world.addScore(ship.id, 10, `pickup-${pickup.pickupType}`);
}
