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
  if (a.kind === "explosion" || b.kind === "explosion") return false;

  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const radius = a.radius + b.radius;
  return dx * dx + dy * dy <= radius * radius;
}

export function resolveCollisions(world) {
  for (const [a, b] of circleCollisions(world)) {
    if (!a.alive || !b.alive) continue;

    if (isPair(a, b, "bullet", "ship")) {
      hitShip(a, b, world);
    } else if (isPair(a, b, "bullet", "asteroid")) {
      hitAsteroid(a, b, world);
    } else if (isPair(a, b, "ship", "pickup")) {
      collectPickup(a, b);
    } else if (isPair(a, b, "ship", "asteroid")) {
      const ship = a.kind === "ship" ? a : b;
      ship.takeDamage(20, world);
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

  if (ship.takeDamage(bullet.damage, world)) {
    if (ship.hp <= 0) world.score += 100;
  }
  bullet.markDead();
}

function hitAsteroid(a, b, world) {
  const bullet = a.kind === "bullet" ? a : b;
  const asteroid = a.kind === "asteroid" ? a : b;

  asteroid.markDead();
  bullet.markDead();
  world.score += 25;

  const { Explosion, Pickup } = world.classes;
  world.spawn(new Explosion({ x: asteroid.pos.x, y: asteroid.pos.y }, 10));

  if (Math.random() < 0.2) {
    const type = Math.random() < 0.5 ? "shield" : "rapid-fire";
    world.spawn(new Pickup({ x: asteroid.pos.x, y: asteroid.pos.y }, type));
  }
}

function collectPickup(a, b) {
  const ship = a.kind === "ship" ? a : b;
  const pickup = a.kind === "pickup" ? a : b;
  pickup.applyTo(ship);
  worldSafeScore(ship, 10);
}

function worldSafeScore(ship, points) {
  ship.score = (ship.score ?? 0) + points;
}
