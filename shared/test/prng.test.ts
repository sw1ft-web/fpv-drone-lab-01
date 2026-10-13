import assert from "node:assert/strict";
import { test } from "node:test";
import { createRng } from "../src/prng.ts";

test("same seed gives the same sequence, different seeds differ", () => {
  const a = createRng(7);
  const b = createRng(7);
  const c = createRng(8);
  const seqA = Array.from({ length: 50 }, () => a.next());
  assert.deepEqual(
    seqA,
    Array.from({ length: 50 }, () => b.next()),
  );
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 50 }, () => c.next()),
  );
});

test("values are in [0, 1) with a sane mean", () => {
  const rng = createRng(99);
  let sum = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1);
    sum += value;
  }
  assert.ok(Math.abs(sum / 10_000 - 0.5) < 0.02);
});

test("range, int and chance stay in bounds", () => {
  const rng = createRng(5);
  for (let i = 0; i < 1000; i += 1) {
    const r = rng.range(10, 20);
    assert.ok(r >= 10 && r < 20);
    const n = rng.int(6);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 6);
  }
  assert.equal(rng.chance(0), false);
  assert.equal(rng.chance(1.01), true);
});

test("getState/setState resume the exact sequence", () => {
  const rng = createRng(11);
  rng.next();
  const state = rng.getState();
  const expected = [rng.next(), rng.next(), rng.next()];
  rng.setState(state);
  assert.deepEqual([rng.next(), rng.next(), rng.next()], expected);
});
