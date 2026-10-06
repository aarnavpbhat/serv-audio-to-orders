/** Synthetic drive-thru noise (engine idle, wind, car radio), shared by the fixture build and the simulator. */
import type { NoiseLevel } from "../schemas";

const SR = 16_000;

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(x: Float32Array): Float32Array {
  let s = 0;
  for (const v of x) s += v * v;
  const r = Math.sqrt(s / Math.max(1, x.length)) || 1;
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) / r;
  return x;
}

/** Engine idle rumble + wind gusts + a faint car radio. Deterministic per seed. */
export function synthNoise(n: number, seed: number, level: NoiseLevel): Float32Array {
  const rand = mulberry32(seed);
  const engine = new Float32Array(n);
  const wind = new Float32Array(n);
  const radio = new Float32Array(n);
  let brown = 0;
  let lp = 0;
  let gust = 0.5;
  const notes = [220, 261.6, 329.6, 392, 440, 523.3];
  let chord = [0, 2, 4];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rand() * 2 - 1;
    brown = 0.995 * brown + 0.05 * white;
    const hum = Math.sin(2 * Math.PI * 31 * t) + 0.6 * Math.sin(2 * Math.PI * 62 * t) + 0.3 * Math.sin(2 * Math.PI * 93 * t);
    engine[i] = (brown * 3 + hum * 0.4) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t));
    lp += 0.12 * (white - lp);
    if (i % 1600 === 0) gust = Math.min(1, Math.max(0.15, gust + (rand() - 0.5) * 0.3));
    wind[i] = lp * gust;
    if (i % (SR * 2) === 0) chord = [0, 1, 2].map(() => Math.floor(rand() * notes.length));
    radio[i] = chord.reduce((s, k) => s + Math.sin(2 * Math.PI * (notes[k] ?? 220) * t), 0) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t));
  }
  normalize(engine);
  normalize(wind);
  normalize(radio);
  const w = level === "heavy" ? { e: 0.7, w: 0.8, r: 0.3 } : { e: 0.7, w: 0.4, r: 0.25 };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = w.e * (engine[i] ?? 0) + w.w * (wind[i] ?? 0) + w.r * (radio[i] ?? 0);
  return normalize(out);
}
