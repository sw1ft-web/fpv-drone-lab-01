import assert from "node:assert/strict";
import { test } from "vitest";
import { createRng } from "../src/prng.ts";
import { LatencyInjector } from "../src/net/latency.ts";

interface Timer {
  at: number;
  fn: () => void;
}

function virtualClock() {
  let time = 0;
  const queue: Timer[] = [];
  return {
    now: () => time,
    schedule: (fn: () => void, ms: number) => queue.push({ at: time + ms, fn }),
    advance(to: number) {
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > to) break;
        queue.shift();
        time = next.at;
        next.fn();
      }
      time = to;
    },
  };
}

test("an inactive injector delivers immediately", () => {
  const seen: string[] = [];
  new LatencyInjector().send("a", (value) => seen.push(value));
  assert.deepEqual(seen, ["a"]);
});

test("latency delays delivery and preserves order despite jitter", () => {
  const clock = virtualClock();
  const rng = createRng(3);
  const injector = new LatencyInjector({
    latencyMs: 50,
    jitterMs: 40,
    random: rng.next,
    ...clock,
  });
  const delivered: [number, number][] = [];
  for (let i = 0; i < 100; i += 1) {
    clock.advance(i * 10);
    injector.send(i, (value) =>
      delivered.push([value, clock.now() - value * 10]),
    );
  }
  clock.advance(5000);
  assert.deepEqual(
    delivered.map(([value]) => value),
    Array.from({ length: 100 }, (_, i) => i),
  );
  assert.ok(delivered.every(([, delay]) => delay >= 10 - 1e-9));
  assert.ok(delivered.some(([, delay]) => delay > 60));
});

test("drop discards about the requested fraction", () => {
  const clock = virtualClock();
  const rng = createRng(8);
  const injector = new LatencyInjector({
    latencyMs: 1,
    drop: 0.2,
    random: rng.next,
    ...clock,
  });
  let received = 0;
  for (let i = 0; i < 5000; i += 1) injector.send(i, () => (received += 1));
  clock.advance(100);
  assert.ok(Math.abs(received / 5000 - 0.8) < 0.03);
  assert.equal(injector.dropped + received, 5000);
});

test("reliable messages are delayed but never dropped", () => {
  const clock = virtualClock();
  const injector = new LatencyInjector({
    latencyMs: 50,
    drop: 1,
    random: () => 0,
    schedule: clock.schedule,
    now: clock.now,
  });
  const seen: string[] = [];
  injector.send("game", (v) => seen.push(v));
  injector.send("control", (v) => seen.push(v), { reliable: true });
  clock.advance(100);
  assert.deepEqual(seen, ["control"]);
  assert.equal(injector.dropped, 1);
});
