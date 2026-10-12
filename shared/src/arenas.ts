export interface ArenaRules {
  readonly asteroids: number;
  readonly pickups: number;
  readonly homingAsteroids: number;
}

/** Gameplay rules per arena id (visual settings stay in the client's arena JSON). */
export const ARENA_RULES = {
  "arena-neon": { asteroids: 8, pickups: 2, homingAsteroids: 1 },
  "arena-training": { asteroids: 5, pickups: 1, homingAsteroids: 0 },
} as const satisfies Record<string, ArenaRules>;

export type ArenaId = keyof typeof ARENA_RULES;

export const DEFAULT_ARENA: ArenaId = "arena-neon";

export const isArenaId = (value: string): value is ArenaId =>
  Object.hasOwn(ARENA_RULES, value);

export function arenaRules(arenaId: string): ArenaRules {
  return isArenaId(arenaId) ? ARENA_RULES[arenaId] : ARENA_RULES[DEFAULT_ARENA];
}
