import type { Vec2 } from "../types.ts";

/** Immutable 2D vector: every operation returns a new one. */
export class Vector2 implements Vec2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(other: Vec2): Vector2 {
    return new Vector2(this.x + other.x, this.y + other.y);
  }

  scale(value: number): Vector2 {
    return new Vector2(this.x * value, this.y * value);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const length = this.length();
    return length === 0 ? new Vector2() : this.scale(1 / length);
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }
}
