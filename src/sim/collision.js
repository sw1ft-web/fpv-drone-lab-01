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

    if (isPair(a, b, "bullet", "ship")) hitShip(a, b, world);
    else if (isPair(a, b, "bullet", "asteroid")) hitAsteroid(a, b, world);
    else if (isPair(a, b, "ship", "pickup")) collectPickup(a, b, world);
    else if (isPair(a, b, "ship", "asteroid")) {
      const ship = a.kind === "ship" ? a : b;
      if (ship.takeDamage(20, world)) {
        world.emit("hit", { target: "ship", damage: 20, hp: ship.hp });
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
  if (ship.takeDamage(bullet.damage, world)) {
    world.emit("hit", { target: "ship", damage: bullet.damage, hp: ship.hp });
    if (ship.hp <= 0) world.addScore(100, "ship-destroyed");
  }
  bullet.markDead();
}

function hitAsteroid(a, b, world) {
  const bullet = a.kind === "bullet" ? a : b;
  const asteroid = a.kind === "asteroid" ? a : b;
  asteroid.markDead();
  bullet.markDead();
  world.addScore(25, "asteroid");
  world.emit("hit", { target: "asteroid", asteroidId: asteroid.id });

  const { Explosion, Pickup } = world.classes;
  world.spawn(new Explosion({ x: asteroid.pos.x, y: asteroid.pos.y }, 10));
  world.emit("exploded", {
    kind: "asteroid",
    id: asteroid.id,
    x: asteroid.pos.x,
    y: asteroid.pos.y,
  });

  if (Math.random() < 0.2) {
    const type = Math.random() < 0.5 ? "shield" : "rapid-fire";
    world.spawn(new Pickup({ x: asteroid.pos.x, y: asteroid.pos.y }, type));
  }
}

function collectPickup(a, b, world) {
  const ship = a.kind === "ship" ? a : b;
  const pickup = a.kind === "pickup" ? a : b;
  pickup.applyTo(ship);
  world.addScore(10, `pickup-${pickup.pickupType}`);
}
