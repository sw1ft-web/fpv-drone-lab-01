/**
 * Micro-benchmark behind the "spatial hash: go / no-go" decision (docs/lab-07.md).
 * Brute force (what shared/src/sim/collision.ts does) vs a uniform grid on random
 * circles, from a realistic room (~60 entities) up to 2000.
 *
 *   node scripts/bench-collision.ts [--out docs/lab-07/bench-collision.json]
 */
import { writeFile } from "node:fs/promises";
import { createRng } from "../shared/src/index.ts";

interface Circle {
  x: number;
  y: number;
  r: number;
}

const hit = (a: Circle, b: Circle): boolean => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = a.r + b.r;
  return dx * dx + dy * dy <= r * r;
};

const brute = (c: readonly Circle[]): number => {
  let pairs = 0;
  for (let i = 0; i < c.length; i += 1) {
    const a = c[i];
    if (!a) continue;
    for (let j = i + 1; j < c.length; j += 1) {
      const b = c[j];
      if (b && hit(a, b)) pairs += 1;
    }
  }
  return pairs;
};

const CELL = 64;
const grid = (c: readonly Circle[], w: number, h: number): number => {
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  c.forEach((a, i) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(a.x / CELL)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(a.y / CELL)));
    cells[cy * cols + cx]?.push(i);
  });
  let pairs = 0;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const here = cells[cy * cols + cx] ?? [];
      for (let oy = 0; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (oy === 0 && ox < 0) continue;
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || nx >= cols || ny >= rows) continue;
          const there = cells[ny * cols + nx] ?? [];
          const same = oy === 0 && ox === 0;
          for (let i = 0; i < here.length; i += 1) {
            for (let j = same ? i + 1 : 0; j < there.length; j += 1) {
              const a = c[here[i] ?? 0];
              const b = c[there[j] ?? 0];
              if (a && b && hit(a, b)) pairs += 1;
            }
          }
        }
      }
    }
  }
  return pairs;
};

function medianMicros(fn: () => number, iterations: number): number {
  for (let i = 0; i < Math.min(200, iterations); i += 1) fn(); // warm-up (JIT)
  const samples: number[] = [];
  for (let run = 0; run < 15; run += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) fn();
    samples.push(((performance.now() - start) * 1000) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

const W = 1600;
const H = 900;
const rows: { n: number; bruteUs: number; gridUs: number; pairs: number }[] =
  [];
for (const n of [20, 60, 120, 250, 500, 1000, 2000]) {
  const rng = createRng(n);
  const circles = Array.from({ length: n }, () => ({
    x: rng.range(0, W),
    y: rng.range(0, H),
    r: rng.range(5, 30),
  }));
  const expected = brute(circles);
  if (expected !== grid(circles, W, H))
    throw new Error("grid disagrees with brute force");
  const iterations = Math.max(5, Math.floor(200_000 / n));
  rows.push({
    n,
    bruteUs: medianMicros(() => brute(circles), iterations),
    gridUs: medianMicros(() => grid(circles, W, H), iterations),
    pairs: expected,
  });
}
console.log("entities | brute O(n^2) us | grid us | pairs");
for (const r of rows)
  console.log(
    `${String(r.n).padStart(8)} | ${r.bruteUs.toFixed(1).padStart(15)} | ${r.gridUs.toFixed(1).padStart(7)} | ${r.pairs}`,
  );

const out = process.argv.indexOf("--out");
const target = out >= 0 ? process.argv[out + 1] : undefined;
if (target)
  await writeFile(
    target,
    `${JSON.stringify({ node: process.version, rows }, null, 2)}\n`,
  );
