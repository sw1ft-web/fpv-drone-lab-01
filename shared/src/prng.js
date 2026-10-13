/**
 * Seeded PRNG (mulberry32). The simulation must never call Math.random():
 * the server and a replay with the same seed and inputs have to agree exactly.
 */
export function createRng(seed = 1) {
  let state = seed >>> 0;

  const next = () => {
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
