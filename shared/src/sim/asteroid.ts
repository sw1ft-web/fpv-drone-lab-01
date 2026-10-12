import type { Vec2 } from "../types.ts";
import { Entity } from "./entity.ts";
import { createHomingBehavior } from "./homing.ts";
import type { HomingBehavior } from "./homing.ts";
import type { World } from "./world.ts";

export class Asteroid extends Entity {
  readonly kind = "asteroid";
  readonly rotationSpeed: number;
  homing: HomingBehavior | null = null;

  constructor(
    pos: Vec2,
    vel: Vec2,
    radius: number,
    angle = 0,
    rotationSpeed = 0,
  ) {
    super({ pos, vel, radius, angle });
    this.rotationSpeed = rotationSpeed;
  }

  makeHoming(strength = 1.1): this {
    this.homing = createHomingBehavior(strength);
    return this;
  }

  override update(dt: number, world: World): void {
    this.homing?.update(this, world, dt);
    this.pos.x =
      (((this.pos.x + this.vel.x * dt) % world.width) + world.width) %
      world.width;
    this.pos.y =
      (((this.pos.y + this.vel.y * dt) % world.height) + world.height) %
      world.height;
    this.angle += this.rotationSpeed * dt;
  }
}
