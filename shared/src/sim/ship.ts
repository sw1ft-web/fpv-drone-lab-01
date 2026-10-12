import { BULLET, SHIP } from "../constants.ts";
import type { SequencedCommand, Seq, Vec2 } from "../types.ts";
import { asSeq } from "../types.ts";
import { Bullet } from "./bullet.ts";
import { Entity } from "./entity.ts";
import { bulletLaunch } from "./integrate.ts";
import type { World } from "./world.ts";

export class Ship extends Entity {
  readonly kind = "ship";
  hp: number = SHIP.maxHp;
  thrust = 0;
  score = 0;
  respawnTimer = 0;
  invulnerable = 0;
  fireCooldown = 0;
  shield = 0;
  rapidFire = 0;

  constructor(pos: Vec2 = { x: 0, y: 0 }) {
    super({ pos, radius: SHIP.radius });
  }

  isActive(): boolean {
    return this.respawnTimer <= 0;
  }

  /**
   * Called once per simulation step. Timers run in world time; movement and
   * firing happen only when a command for this step exists, so the ship's
   * kinematics are a pure function of the commands the player has sent.
   */
  override update(dt: number, world: World, command?: SequencedCommand): void {
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
    if (command.fire) this.fire(world, command.seq ?? asSeq(0));
  }

  fire(world: World, fireSeq: Seq = asSeq(0)): Bullet | null {
    if (this.respawnTimer > 0 || this.fireCooldown > 0) return null;

    const { pos, vel } = bulletLaunch(this);
    const bullet = world.spawn(new Bullet(pos, vel, this.id, fireSeq));
    this.fireCooldown =
      this.rapidFire > 0 ? BULLET.rapidCooldown : BULLET.cooldown;
    world.bus.emit("fired", { shipId: this.id, bulletId: bullet.id });
    return bullet;
  }

  takeDamage(amount: number, world: World): boolean {
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

  destroy(world: World): void {
    if (this.respawnTimer > 0) return;
    world.bus.emit("exploded", {
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

  respawn(world: World): void {
    const margin = 80;
    this.pos.x = world.rng.range(margin, world.width - margin);
    this.pos.y = world.rng.range(margin, world.height - margin);
    this.angle = world.rng.range(0, Math.PI * 2);
    this.hp = SHIP.maxHp;
    this.invulnerable = SHIP.invulnerableSeconds;
  }
}
