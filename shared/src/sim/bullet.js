import { BULLET } from "../constants.js";
import { Entity } from "./entity.js";
import { integrateBullet } from "./integrate.js";

export class Bullet extends Entity {
  constructor(pos, vel, ownerId = 0, fireSeq = 0) {
    super({ pos, vel, radius: BULLET.radius, kind: "bullet" });
    this.ttl = BULLET.ttl;
    this.damage = BULLET.damage;
    this.ownerId = ownerId;
    this.fireSeq = fireSeq;
  }

  update(dt, world) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.markDead();
      return;
    }
    integrateBullet(this, dt, world.width, world.height);
  }
}
