import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import { TokenBucket } from "../src/ratelimit.ts";

describe("TokenBucket properties", () => {
  test("never lets through more than capacity + rate * elapsed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 0, max: 200 }), {
          minLength: 1,
          maxLength: 200,
        }),
        (capacity, rate, gaps) => {
          let now = 0;
          const bucket = new TokenBucket({
            capacity,
            refillPerSec: rate,
            now: () => now,
          });
          let allowed = 0;
          for (const gap of gaps) {
            now += gap;
            if (bucket.take()) allowed += 1;
          }
          assert.ok(allowed <= capacity + (rate * now) / 1000 + 1e-9);
        },
      ),
    );
  });

  test("the token count stays within [0, capacity]", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 5000 }),
            cost: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 100 },
        ),
        (events) => {
          let now = 0;
          const bucket = new TokenBucket({
            capacity: 10,
            refillPerSec: 5,
            now: () => now,
          });
          for (const { gap, cost } of events) {
            now += gap;
            bucket.take(cost);
            assert.ok(bucket.tokens >= 0 && bucket.tokens <= 10 + 1e-9);
          }
        },
      ),
    );
  });
});
