import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

export class Explosion extends Entity {
  constructor(pos, count = 16) {
    super({ pos, radius: 0, kind: "explosion" });
    this.life = 0.65;
    this.particles = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 180;
      return {
        pos: new Vector2(pos.x, pos.y),
        vel: Vector2.fromAngle(angle, speed),
        life: 0.3 + Math.random() * 0.35,
        size: 2 + Math.random() * 3,
      };
    });
  }

  update(dt) {
    this.life -= dt;
    for (const particle of this.particles) {
      particle.life -= dt;
      particle.pos = particle.pos.add(particle.vel.scale(dt));
      particle.vel = particle.vel.scale(Math.pow(0.04, dt));
    }
    if (this.life <= 0) this.markDead();
  }
}
