import assert from "node:assert/strict";
import { test } from "vitest";
import { TokenBucket } from "../src/ratelimit.ts";

test("allows a burst up to capacity, then refuses", () => {
  const time = 0;
  const bucket = new TokenBucket({
    capacity: 3,
    refillPerSec: 1,
    now: () => time,
  });
  assert.deepEqual(
    [bucket.take(), bucket.take(), bucket.take(), bucket.take()],
    [true, true, true, false],
  );
});

test("refills over time but never above capacity", () => {
  let time = 0;
  const bucket = new TokenBucket({
    capacity: 2,
    refillPerSec: 2,
    now: () => time,
  });
  bucket.take();
  bucket.take();
  assert.equal(bucket.take(), false);
  time = 500; // +1 token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  time = 60_000;
  bucket.take();
  assert.ok(bucket.tokens <= 2);
});
