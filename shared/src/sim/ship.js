import { BULLET, SHIP } from "../constants.js";
import { Bullet } from "./bullet.js";
import { Entity } from "./entity.js";
import { bulletLaunch } from "./integrate.js";

export class Ship extends Entity {
  constructor(pos = { x: 0, y: 0 }) {
    super({ pos, radius: SHIP.radius, kind: "ship" });
    this.hp = SHIP.maxHp;
    this.thrust = 0;
    this.score = 0;
    this.respawnTimer = 0;
    this.invulnerable = 0;
    this.fireCooldown = 0;
    this.shield = 0;
    this.rapidFire = 0;
  }

  isActive() {
    return this.respawnTimer <= 0;
  }

  /**
   * Called once per simulation step. Timers run in world time; movement and
   * firing happen only when a command for this step exists, so the ship's
   * kinematics are a pure function of the commands the player has sent.
   */
  update(dt, world, command) {
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(world);
      return;
    }

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.rapidFire = Math.max(0, this.rapidFire - dt);

    if (!command) return;

    world.integrate(this, command, dt, world.width, world.height);
    if (command.fire) this.fire(world, command.seq ?? 0);
  }

  fire(world, fireSeq = 0) {
    if (this.respawnTimer > 0 || this.fireCooldown > 0) return null;

    const { pos, vel } = bulletLaunch(this);
    const bullet = world.spawn(new Bullet(pos, vel, this.id, fireSeq));
    this.fireCooldown =
      this.rapidFire > 0 ? BULLET.rapidCooldown : BULLET.cooldown;
    world.emit("fired", { shipId: this.id, bulletId: bullet.id });
    return bullet;
  }

  takeDamage(amount, world) {
    if (this.respawnTimer > 0 || this.invulnerable > 0) return false;
    if (this.shield > 0) {
      this.shield = Math.max(0, this.shield - 1.5);
      return false;
    }

    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.destroy(world);
    }
    return true;
  }

  destroy(world) {
    if (this.respawnTimer > 0) return;
    world.emit("exploded", {
      kind: "ship",
      id: this.id,
      x: this.pos.x,
      y: this.pos.y,
    });
    this.respawnTimer = SHIP.respawnSeconds;
    this.vel.x = 0;
    this.vel.y = 0;
    this.thrust = 0;
  }

  respawn(world) {
    const margin = 80;
    this.pos.x = world.rng.range(margin, world.width - margin);
    this.pos.y = world.rng.range(margin, world.height - margin);
    this.angle = world.rng.range(0, Math.PI * 2);
    this.hp = SHIP.maxHp;
    this.invulnerable = SHIP.invulnerableSeconds;
  }
}
