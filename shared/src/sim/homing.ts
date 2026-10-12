import type { Entity } from "./entity.ts";
import type { World } from "./world.ts";
import { Vector2 } from "./vector.ts";

export interface HomingBehavior {
  readonly targetKind: "ship";
  readonly strength: number;
  update(entity: Entity, world: World, dt: number): void;
}

/** Steers an entity towards the nearest active ship. */
export function createHomingBehavior(strength = 2.4): HomingBehavior {
  return {
    targetKind: "ship",
    strength,

    update(entity, world, dt) {
      let nearest: Entity | null = null;
      let nearestDistance = Infinity;

      for (const candidate of world.ships()) {
        if (!candidate.alive || candidate === entity) continue;
        if (!candidate.isActive()) continue;

        const distance = Math.hypot(
          candidate.pos.x - entity.pos.x,
          candidate.pos.y - entity.pos.y,
        );
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
      const direction = current
        .scale(1 - strength * dt)
        .add(desired.scale(strength * dt))
        .normalize();
      const speed = Math.max(80, Math.hypot(entity.vel.x, entity.vel.y));

      entity.vel.x = direction.x * speed;
      entity.vel.y = direction.y * speed;
    },
  };
}
