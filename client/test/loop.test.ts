import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createLoop } from "../src/loop.ts";

/** A manual requestAnimationFrame: tests decide when each frame happens and what time it reports. */
let queued: ((now: number) => void) | null = null;
let clock = 0;

beforeEach(() => {
  clock = 0;
  queued = null;
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => {
    queued = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queued = null;
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Advances the fake clock by `ms` and runs one frame. */
function frame(ms: number): void {
  clock += ms;
  const run = queued;
  assert.ok(run, "no frame was scheduled");
  queued = null;
  run(clock);
}

describe("fixed-step accumulator loop", () => {
  test("runs exactly one step per 1/60 s regardless of frame rate", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => (steps += 1), render: () => {} });
    loop.start();
    // 30 fps display: two steps per frame.
    for (let i = 0; i < 30; i += 1) frame(1000 / 30);
    assert.ok(Math.abs(steps - 60) <= 1, `steps=${steps}`);
    loop.stop();
  });

  test("a 144 Hz display still simulates at 60 steps per second", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => (steps += 1), render: () => {} });
    loop.start();
    for (let i = 0; i < 144; i += 1) frame(1000 / 144);
    assert.ok(Math.abs(steps - 60) <= 1, `steps=${steps}`);
    loop.stop();
  });

  test("a long stall is clamped, so the game does not run a spiral of death", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => (steps += 1), render: () => {} });
    loop.start();
    frame(10_000); // tab was in the background for 10 s
    assert.ok(steps <= 16, `steps=${steps}`); // 0.25 s / (1/60 s) = 15
    loop.stop();
  });

  test("render receives the leftover fraction of a step as alpha", () => {
    const alphas: number[] = [];
    const loop = createLoop({
      simulate: () => {},
      render: (alpha) => alphas.push(alpha),
    });
    loop.start();
    frame(1000 / 120); // half a step
    assert.ok(Math.abs((alphas[0] ?? -1) - 0.5) < 1e-9);
    loop.stop();
  });

  test("stop() ends the loop and start() resets the accumulator", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => (steps += 1), render: () => {} });
    loop.start();
    frame(1000 / 60);
    loop.stop();
    assert.equal(queued, null);
    const before = steps;
    clock += 5000;
    loop.start();
    frame(1000 / 60);
    assert.ok(steps - before <= 2, "the paused time was not replayed");
  });

  test("reports step and frame rates once a second", () => {
    const reports: { steps: number; fps: number }[] = [];
    const loop = createLoop({
      simulate: () => {},
      render: () => {},
      onStats: (s) =>
        reports.push({ steps: s.stepsPerSecond, fps: s.framesPerSecond }),
    });
    loop.start();
    for (let i = 0; i < 125; i += 1) frame(1000 / 60);
    assert.equal(reports.length, 2);
    assert.ok(Math.abs((reports[0]?.steps ?? 0) - 60) < 2);
    loop.stop();
  });
});
