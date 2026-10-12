/** Fixed arena: the simulation never depends on the size of the browser window. */
export const ARENA_WIDTH = 1600;
export const ARENA_HEIGHT = 900;

/** The simulation advances in fixed steps; the server sends a snapshot every STEPS_PER_TICK steps. */
export const SIM_HZ = 60;
export const SIM_STEP = 1 / SIM_HZ;
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const STEPS_PER_TICK = SIM_HZ / TICK_HZ;

export const TAU = Math.PI * 2;

export const SHIP = Object.freeze({
  radius: 24,
  rotationSpeed: 3.2,
  thrust: 260,
  drag: 0.992,
  brakeDrag: 0.94,
  maxSpeed: 520,
  maxHp: 100,
  respawnSeconds: 2,
  invulnerableSeconds: 2,
});

/**
 * Lab 01-03 fired bullets at ~100 px/s, slower than the ship itself, which is
 * unplayable once two humans fly at each other. Bullets now leave the nose at
 * 640 px/s relative to the shooter.
 */
export const BULLET = Object.freeze({
  radius: 5,
  speed: 640,
  ttl: 2,
  damage: 25,
  cooldown: 0.22,
  rapidCooldown: 0.09,
});

export const SNAPSHOT_FLAGS = Object.freeze({
  ACTIVE: 1,
  INVULNERABLE: 2,
  SHIELD: 4,
  RAPID_FIRE: 8,
  THRUST: 16,
});
