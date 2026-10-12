import { Entity } from "./entity.js";
import { createHomingBehavior } from "./homing.js";

export class Asteroid extends Entity {
  constructor(pos, vel, radius, angle = 0, rotationSpeed = 0) {
    super({ pos, vel, radius, angle, kind: "asteroid" });
    this.rotationSpeed = rotationSpeed;
    this.homing = null;
  }

  makeHoming(strength = 1.1) {
    this.homing = createHomingBehavior("ship", strength);
    return this;
  }

  update(dt, world) {
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
