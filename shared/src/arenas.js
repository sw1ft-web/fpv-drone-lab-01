/** Gameplay rules per arena id (visual settings stay in the client's arena JSON). */
export const ARENA_RULES = Object.freeze({
  "arena-neon": { asteroids: 8, pickups: 2, homingAsteroids: 1 },
  "arena-training": { asteroids: 5, pickups: 1, homingAsteroids: 0 },
});

export const DEFAULT_ARENA = "arena-neon";

export function arenaRules(arenaId) {
  return ARENA_RULES[arenaId] ?? ARENA_RULES[DEFAULT_ARENA];
}
