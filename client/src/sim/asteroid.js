import { Entity } from "./entity.js";

export class Asteroid extends Entity {
  constructor(pos, vel, radius = 22 + Math.random() * 18) {
    super({ pos, vel, radius, kind: "asteroid" });
    this.rotationSpeed = (Math.random() - 0.5) * 1.2;
    this.angle = Math.random() * Math.PI * 2;
    this.homing = null;
  }

  update(dt, world) {
    if (this.homing) {
      this.homing.update(this, world, dt);
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.angle += this.rotationSpeed * dt;

    this.pos.x = ((this.pos.x % world.width) + world.width) % world.width;
    this.pos.y = ((this.pos.y % world.height) + world.height) % world.height;
  }
}
