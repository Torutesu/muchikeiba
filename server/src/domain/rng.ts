/** Randomness source. Production uses crypto (REQ-GACHA-007); tests inject a seeded one. */
export interface Rng {
  /** Uniform uint32. */
  nextU32(): number;
}

export const cryptoRng: Rng = {
  nextU32() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]!;
  },
};

/** Deterministic test RNG (SplitMix32-like). Never used for real money/gacha in production. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return {
    nextU32() {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    },
  };
}

/** Unbiased integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) throw new Error(`randInt: bad n ${n}`);
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const x = rng.nextU32();
    if (x < limit) return x % n;
  }
}

/** Integer in [lo, hi] inclusive. */
export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + randInt(rng, hi - lo + 1);
}

/** uint64 as decimal string. */
export function randU64Decimal(rng: Rng): string {
  const hi = BigInt(rng.nextU32());
  const lo = BigInt(rng.nextU32());
  return ((hi << 32n) | lo).toString(10);
}

/** Random id with prefix (not security sensitive beyond uniqueness). */
export function randomId(prefix: string, rng: Rng = cryptoRng): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += rng.nextU32().toString(36).padStart(7, '0');
  return `${prefix}_${s}`;
}
