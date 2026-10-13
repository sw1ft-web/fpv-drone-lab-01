import { BULLET } from "../constants.ts";
import type { EntityId, Seq, Vec2 } from "../types.ts";
import { asEntityId, asSeq } from "../types.ts";
import { Entity } from "./entity.ts";
import { integrateBullet } from "./integrate.ts";
import type { World } from "./world.ts";

export class Bullet extends Entity {
  readonly kind = "bullet";
  ttl = BULLET.ttl;
  readonly damage = BULLET.damage;
  readonly ownerId: EntityId;
  readonly fireSeq: Seq;

  constructor(
    pos: Vec2,
    vel: Vec2,
    ownerId: EntityId = asEntityId(0),
    fireSeq: Seq = asSeq(0),
  ) {
    super({ pos, vel, radius: BULLET.radius });
    this.ownerId = ownerId;
    this.fireSeq = fireSeq;
  }

  override update(dt: number, world: World): void {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.markDead();
      return;
    }
    integrateBullet(this, dt, world.width, world.height);
  }
}
