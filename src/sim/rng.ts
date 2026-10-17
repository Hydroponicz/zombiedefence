// Mulberry32. The state is a plain number so it can live inside the serialisable city state,
// which keeps runs deterministic and reproducible from a seed.

export function nextRandom(state: { rng: number }): number {
  let a = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

export function hashSeed(seed: number | string): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Stand-alone seeded generator for one-off use (e.g. city geometry). */
export function makeRandom(seed: number | string): () => number {
  const state = { rng: hashSeed(seed) };
  return () => nextRandom(state);
}
