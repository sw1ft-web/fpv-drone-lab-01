import type {
  EntityId,
  EntityKind,
  MutableVec2,
  SequencedCommand,
  Vec2,
} from "../types.ts";
import { asEntityId } from "../types.ts";
import type { World } from "./world.ts";

export interface EntityInit {
  pos?: Vec2;
  vel?: Vec2;
  angle?: number;
  radius?: number;
}

/**
 * Base entity. Ids are assigned by the World on spawn so they are
 * deterministic per match. Subclasses fix `kind` to a literal type, which makes
 * the union `Ship | Bullet | Asteroid | Pickup` discriminated by `kind`.
 */
export abstract class Entity {
  abstract readonly kind: EntityKind;
  id: EntityId = asEntityId(0);
  readonly pos: MutableVec2;
  readonly vel: MutableVec2;
  angle: number;
  readonly radius: number;
  alive = true;

  constructor({
    pos = { x: 0, y: 0 },
    vel = { x: 0, y: 0 },
    angle = 0,
    radius = 10,
  }: EntityInit = {}) {
    this.pos = { x: pos.x, y: pos.y };
    this.vel = { x: vel.x, y: vel.y };
    this.angle = angle;
    this.radius = radius;
  }

  update(_dt: number, _world: World, _command?: SequencedCommand): void {}

  markDead(): void {
    this.alive = false;
  }
}
