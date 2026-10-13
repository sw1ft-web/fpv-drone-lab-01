import { Entity } from "./entity.js";

export class Bullet extends Entity {
  constructor(pos, vel) {
    super({ pos, vel, radius: 5, kind: "bullet" });
    this.ttl = 2;
    this.damage = 25;
    this.homing = null;
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.markDead();
      return;
    }

    if (this.homing) {
      this.homing.update(this, world, dt);
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    wrapPosition(this.pos, world.width, world.height);
  }
}

function wrapPosition(pos, width, height) {
  pos.x = ((pos.x % width) + width) % width;
  pos.y = ((pos.y % height) + height) % height;
}
