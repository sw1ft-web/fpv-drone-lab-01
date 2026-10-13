/** Purely visual particles. They live on the client only: the server never simulates explosions. */
export class Effects {
  constructor() {
    this.explosions = [];
  }

  explode(x, y, count = 16) {
    this.explosions.push({
      x,
      y,
      life: 0.65,
      particles: Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2;
        const speed = 50 + Math.random() * 180;
        return {
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.3 + Math.random() * 0.35,
          size: 2 + Math.random() * 3,
        };
      }),
    });
  }

  update(dt) {
    for (const explosion of this.explosions) {
      explosion.life -= dt;
      const damping = Math.pow(0.04, dt);
      for (const p of explosion.particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= damping;
        p.vy *= damping;
      }
    }
    this.explosions = this.explosions.filter((e) => e.life > 0);
  }
}
