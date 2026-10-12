/**
 * Seeded PRNG (mulberry32). The simulation must never call Math.random():
 * the server and a replay with the same seed and inputs have to agree exactly.
 */
export interface Rng {
  readonly next: () => number;
  readonly range: (min: number, max: number) => number;
  readonly int: (maxExclusive: number) => number;
  readonly chance: (probability: number) => boolean;
  readonly getState: () => number;
  readonly setState: (value: number) => void;
}

export function createRng(seed = 1): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    chance: (probability) => next() < probability,
    getState: () => state,
    setState: (value) => {
      state = value >>> 0;
    },
  };
}
