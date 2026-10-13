/**
 * Purely visual particles. They live on the client only: the server never
 * simulates explosions.
 *
 * Particles come from a fixed pool (an Object Pool: preallocate once, recycle
 * instead of `new`). An explosion used to allocate an array plus up to 28 objects
 * which survived ~0.65 s, long enough to be promoted to the old generation and
 * contribute to major GCs; now spawning is just overwriting fields.
 */
export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

export const PARTICLE_POOL_SIZE = 512;
const MAX_LIFE = 0.65;

export class Effects {
  /** Every particle that exists, active or not. Never grows or shrinks. */
  readonly particles: Particle[] = Array.from(
    { length: PARTICLE_POOL_SIZE },
    () => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, size: 0 }),
  );
  #cursor = 0;
  activeCount = 0;

  /** Spawns `count` particles; when the pool is exhausted the oldest slots are recycled. */
  explode(x: number, y: number, count = 16): void {
    const pool = this.particles;
    for (let i = 0; i < count; i += 1) {
      const particle = pool[this.#cursor];
      this.#cursor = (this.#cursor + 1) % pool.length;
      if (!particle) continue;
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 180;
      particle.active = true;
      particle.x = x;
      particle.y = y;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
      particle.life = 0.3 + Math.random() * 0.35;
      particle.size = 2 + Math.random() * 3;
    }
  }

  update(dt: number): void {
    const damping = Math.pow(0.04, dt);
    let active = 0;
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damping;
      p.vy *= damping;
      active += 1;
    }
    this.activeCount = active;
  }
}

export { MAX_LIFE };
