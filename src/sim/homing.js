import { Vector2 } from "./vector.js";

export function createHomingBehavior(targetKind = "ship", strength = 2.4) {
  return {
    targetKind,
    strength,

    update(entity, world, dt) {
      let nearest = null;
      let nearestDistance = Infinity;

      for (const candidate of world.ofKind(targetKind)) {
        if (!candidate.alive || candidate === entity) continue;
        if (candidate.kind === "ship" && !candidate.isActive()) continue;

        const dx = candidate.pos.x - entity.pos.x;
        const dy = candidate.pos.y - entity.pos.y;
        const distance = Math.hypot(dx, dy);

        if (distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }

      if (!nearest) return;

      const desired = new Vector2(
        nearest.pos.x - entity.pos.x,
        nearest.pos.y - entity.pos.y,
      ).normalize();

      const current = new Vector2(entity.vel.x, entity.vel.y).normalize();
      const direction = current.scale(1 - strength * dt).add(desired.scale(strength * dt)).normalize();
      const speed = Math.max(80, Math.hypot(entity.vel.x, entity.vel.y));

      entity.vel.x = direction.x * speed;
      entity.vel.y = direction.y * speed;
    },
  };
}
