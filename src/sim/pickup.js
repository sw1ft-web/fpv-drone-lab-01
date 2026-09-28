import { Entity } from "./entity.js";

export class Pickup extends Entity {
  constructor(pos, type = "shield") {
    super({ pos, radius: 13, kind: "pickup" });
    this.pickupType = type;
    this.life = 15;
    this.phase = Math.random() * Math.PI * 2;
  }

  update(dt) {
    this.life -= dt;
    this.phase += dt * 3;
    if (this.life <= 0) this.markDead();
  }

  applyTo(ship) {
    if (this.pickupType === "shield") ship.shield = 8;
    if (this.pickupType === "rapid-fire") ship.rapidFire = 8;
    this.markDead();
  }
}
