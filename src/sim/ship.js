import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

const ROTATION_SPEED = 3.2;
const THRUST = 260;
const DRAG = 0.992;
const MAX_SPEED = 520;

export class Ship extends Entity {
  #hp = 100;

  constructor(pos = { x: 0, y: 0 }) {
    super({
      pos,
      radius: 24,
      kind: "ship",
    });
    this.thrust = 0;
    this.score = 0;
    this.respawnTimer = 0;
    this.invulnerable = 0;
    this.fireCooldown = 0;
    this.shield = 0;
    this.rapidFire = 0;
  }

  get hp() {
    return this.#hp;
  }

  update(dt, world, input) {
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(world);
      return;
    }

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.rapidFire = Math.max(0, this.rapidFire - dt);

    const left = input.isDown("KeyA") || input.isDown("ArrowLeft");
    const right = input.isDown("KeyD") || input.isDown("ArrowRight");
    const accelerating = input.isDown("KeyW") || input.isDown("ArrowUp");
    const braking = input.isDown("Space");

    if (left) this.angle -= ROTATION_SPEED * dt;
    if (right) this.angle += ROTATION_SPEED * dt;

    this.thrust = accelerating ? 1 : 0;

    if (accelerating) {
      const thrust = Vector2.fromAngle(this.angle, THRUST * dt);
      this.vel.x += thrust.x;
      this.vel.y += thrust.y;
    }

    const dragFactor = braking ? 0.94 : Math.pow(DRAG, dt * 60);
    this.vel.x *= dragFactor;
    this.vel.y *= dragFactor;

    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed;
      this.vel.x *= scale;
      this.vel.y *= scale;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    if (input.justPressed("Space") && this.fireCooldown <= 0) {
      this.fire(world);
    }
  }

  fire(world) {
    if (this.respawnTimer > 0 || this.fireCooldown > 0) return null;

    const { Bullet } = world.classes;
    const nose = Vector2.fromAngle(this.angle, this.radius + 8);
    const inherited = new Vector2(this.vel.x, this.vel.y);
    const bullet = new Bullet(
      {
        x: this.pos.x + nose.x,
        y: this.pos.y + nose.y,
      },
      {
        x: inherited.x + nose.x * 3.2,
        y: inherited.y + nose.y * 3.2,
      },
    );

    world.spawn(bullet);
    this.fireCooldown = this.rapidFire > 0 ? 0.09 : 0.22;
    return bullet;
  }

  takeDamage(amount, world) {
    if (this.respawnTimer > 0 || this.invulnerable > 0) return false;

    if (this.shield > 0) {
      this.shield = Math.max(0, this.shield - 1.5);
      return false;
    }

    this.#hp -= amount;

    if (this.#hp <= 0) {
      this.#hp = 0;
      this.destroy(world);
    }
    return true;
  }

  destroy(world) {
    if (this.respawnTimer > 0) return;

    const { Explosion } = world.classes;
    world.spawn(new Explosion({ x: this.pos.x, y: this.pos.y }, 18));
    this.respawnTimer = 2;
    this.vel.x = 0;
    this.vel.y = 0;
    this.thrust = 0;
  }

  respawn(world) {
    const margin = 80;
    this.pos.x = margin + Math.random() * Math.max(1, world.width - margin * 2);
    this.pos.y = margin + Math.random() * Math.max(1, world.height - margin * 2);
    this.angle = Math.random() * Math.PI * 2;
    this.#hp = 100;
    this.invulnerable = 2;
  }

  isActive() {
    return this.respawnTimer <= 0;
  }
}
