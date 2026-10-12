#!/usr/bin/env node
/**
 * Lab 05 experiments, run headlessly on a virtual clock.
 *   node scripts/netcode-sim.mjs            -> docs/lab-05/netcode-results.json (+ table on stdout)
 *
 * 1. condition sweep: latency x jitter x drop, JSON codec;
 * 2. codec comparison at the same conditions (bytes per second);
 * 3. the determinism experiment: Math.random() inside the shared integrate().
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { integrateShip } from "../shared/src/index.js";
import { runSession } from "./lib/netsim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "lab-05");
const seconds = 30;

const fmt = (value, digits = 2) => Number(value.toFixed(digits));

const conditions = [
  { name: "LAN", latencyMs: 0, jitterMs: 0, drop: 0 },
  { name: "good", latencyMs: 40, jitterMs: 5, drop: 0 },
  { name: "100 ms", latencyMs: 100, jitterMs: 20, drop: 0 },
  { name: "100 ms + 5% loss", latencyMs: 100, jitterMs: 20, drop: 0.05 },
  { name: "200 ms", latencyMs: 200, jitterMs: 40, drop: 0 },
  { name: "200 ms + 10% loss", latencyMs: 200, jitterMs: 40, drop: 0.1 },
];

const sweep = conditions.map((condition) => {
  const r = runSession({ seconds, ...condition });
  return {
    ...condition,
    rttMs: fmt(r.rttMs, 1),
    mispredictions: r.mispredictions,
    teleports: r.teleports,
    maxCorrectionPx: fmt(r.maxCorrectionPx, 3),
    ownJumpMaxPx: fmt(r.ownJumpMax, 2),
    remoteJumpP99Px: fmt(r.remoteJumpP99),
    remoteJumpMaxPx: fmt(r.remoteJumpMax),
    noInterpolationJumpP99Px: fmt(r.remoteBaselineJumpP99),
    noInterpolationJumpMaxPx: fmt(r.remoteBaselineJumpMax),
    kbPerSecUp: fmt(r.kbPerSecUp),
    pendingAtEnd: r.finalSeq - r.finalAck,
  };
});

const codecs = ["json", "binary"].map((codec) => {
  const r = runSession({ seconds, codec, latencyMs: 100, jitterMs: 20 });
  return {
    codec,
    kbPerSecDown: fmt(r.kbPerSecDown),
    kbPerSecUp: fmt(r.kbPerSecUp),
    snapshotBytes: Math.round((r.kbPerSecDown * 1024) / 30),
    mispredictions: r.mispredictions,
    maxCorrectionPx: fmt(r.maxCorrectionPx, 4),
  };
});

// How much history does interpolation need? Very bad network (30% loss, 60 ms jitter).
const interpolation = [50, 100, 150, 200].map((interpolationDelayMs) => {
  const r = runSession({
    seconds,
    latencyMs: 100,
    jitterMs: 60,
    drop: 0.3,
    interpolationDelayMs,
  });
  return {
    interpolationDelayMs,
    remoteJumpP99Px: fmt(r.remoteJumpP99),
    remoteJumpMaxPx: fmt(r.remoteJumpMax),
  };
});

// Break determinism on both sides: each side now disagrees about where thrust goes.
const noisy = (ship, command, dt, width, height) => {
  integrateShip(ship, command, dt, width, height);
  ship.pos.x += (Math.random() - 0.5) * 0.8;
  ship.pos.y += (Math.random() - 0.5) * 0.8;
};
const baseline = runSession({ seconds, latencyMs: 100, jitterMs: 20 });
const broken = runSession({
  seconds,
  latencyMs: 100,
  jitterMs: 20,
  serverIntegrate: noisy,
  clientIntegrate: noisy,
});
const determinism = {
  note: "Math.random() added to integrate(): +-0.4 px of noise per step, independently on client and server",
  deterministic: {
    mispredictions: baseline.mispredictions,
    maxCorrectionPx: fmt(baseline.maxCorrectionPx, 4),
  },
  withMathRandom: {
    mispredictions: broken.mispredictions,
    reconciliations: broken.reconciliations,
    maxCorrectionPx: fmt(broken.maxCorrectionPx, 3),
  },
};

const results = {
  seconds,
  players: 2,
  sweep,
  codecs,
  interpolation,
  determinism,
};
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, "netcode-results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.table(sweep);
console.table(codecs);
console.table(interpolation);
console.log(JSON.stringify(determinism, null, 2));
