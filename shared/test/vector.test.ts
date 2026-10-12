import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Vector2 } from "../src/index.ts";

describe("Vector2", () => {
  test("defaults to the zero vector", () => {
    const v = new Vector2();
    assert.deepEqual([v.x, v.y], [0, 0]);
  });

  test("add and scale return new vectors and never mutate", () => {
    const a = new Vector2(1, 2);
    const sum = a.add({ x: 3, y: 4 });
    const scaled = a.scale(-2);
    assert.deepEqual([a.x, a.y], [1, 2]);
    assert.deepEqual([sum.x, sum.y], [4, 6]);
    assert.deepEqual([scaled.x, scaled.y], [-2, -4]);
  });

  test("length is the Euclidean norm", () => {
    assert.equal(new Vector2(3, 4).length(), 5);
  });

  test("normalize gives a unit vector, and the zero vector stays zero", () => {
    const unit = new Vector2(10, 0).normalize();
    assert.deepEqual([unit.x, unit.y], [1, 0]);
    assert.ok(Math.abs(new Vector2(3, 4).normalize().length() - 1) < 1e-12);
    const zero = new Vector2().normalize();
    assert.deepEqual([zero.x, zero.y], [0, 0]);
  });

  test("fromAngle points where the angle says", () => {
    const up = Vector2.fromAngle(Math.PI / 2, 5);
    assert.ok(Math.abs(up.x) < 1e-12);
    assert.ok(Math.abs(up.y - 5) < 1e-12);
  });
});
