import { COMMAND_BITS, createRng } from "@fpv/shared";
import type { AnyEntity, EntityId, Rng, World } from "@fpv/shared";

/**
 * What produces a player's input for one simulation step. A human's source is
 * the network (the client sends bits); a bot's is this interface. Either way
 * the Match only ever sees `InputEntry { seq, bits }` — it cannot tell them apart.
 */
export interface PlayerInput {
  nextBits(): number;
}

const AIM_TOLERANCE = 0.12;
const FIRE_RANGE = 520;
const FIRE_CONE = 0.22;
const CHASE_DISTANCE = 260;
const EVADE_DISTANCE = 120;
const MAX_CRUISE_SPEED = 240;

const TAU = Math.PI * 2;
const wrapAngle = (angle: number): number => {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};
const wrapDelta = (from: number, to: number, size: number): number => {
  let d = to - from;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
};

/**
 * A server-side pilot: chases the nearest other ship (or, failing that, the
 * nearest asteroid), shoots when roughly aimed, and steers away from asteroids
 * that get too close. It only reads the world and returns input bits.
 */
export class Bot implements PlayerInput {
  readonly #world: World;
  readonly #shipId: EntityId;
  readonly #rng: Rng;

  constructor(world: World, shipId: EntityId, seed = 1) {
    this.#world = world;
    this.#shipId = shipId;
    this.#rng = createRng(seed);
  }

  nextBits(): number {
    const me = this.#world.get(this.#shipId);
    if (me?.kind !== "ship" || !me.isActive()) return 0;

    const world = this.#world;
    let target: AnyEntity | null = null;
    let targetDistance = Infinity;
    let threat: AnyEntity | null = null;
    let threatDistance = Infinity;
    for (const entity of world) {
      if (entity === me || !entity.alive) continue;
      const dx = wrapDelta(me.pos.x, entity.pos.x, world.width);
      const dy = wrapDelta(me.pos.y, entity.pos.y, world.height);
      const distance = Math.hypot(dx, dy);
      if (
        (entity.kind === "ship" || entity.kind === "asteroid") &&
        distance < targetDistance &&
        (entity.kind === "ship" ? entity.isActive() : true)
      ) {
        // Prefer ships: an asteroid only counts when no ship is closer than 2x its distance.
        const weight = entity.kind === "ship" ? distance : distance * 2;
        if (weight < targetDistance) {
          target = entity;
          targetDistance = weight;
        }
      }
      if (entity.kind === "asteroid" && distance < threatDistance) {
        threat = entity;
        threatDistance = distance;
      }
    }

    let bits = 0;
    const speed = Math.hypot(me.vel.x, me.vel.y);

    if (threat && threatDistance < EVADE_DISTANCE + threat.radius) {
      const bearing = Math.atan2(
        wrapDelta(me.pos.y, threat.pos.y, world.height),
        wrapDelta(me.pos.x, threat.pos.x, world.width),
      );
      // Turn to point opposite the threat, then burn.
      const diff = wrapAngle(bearing + Math.PI - me.angle);
      if (diff > AIM_TOLERANCE) bits |= COMMAND_BITS.right;
      else if (diff < -AIM_TOLERANCE) bits |= COMMAND_BITS.left;
      else bits |= COMMAND_BITS.thrust;
      return bits;
    }

    if (!target) return this.#rng.chance(0.5) ? COMMAND_BITS.right : 0;

    const bearing = Math.atan2(
      wrapDelta(me.pos.y, target.pos.y, world.height),
      wrapDelta(me.pos.x, target.pos.x, world.width),
    );
    const diff = wrapAngle(bearing - me.angle);
    if (diff > AIM_TOLERANCE) bits |= COMMAND_BITS.right;
    else if (diff < -AIM_TOLERANCE) bits |= COMMAND_BITS.left;

    if (Math.abs(diff) < FIRE_CONE && targetDistance < FIRE_RANGE) {
      if (this.#rng.chance(0.35)) bits |= COMMAND_BITS.fire;
    }
    if (targetDistance > CHASE_DISTANCE && speed < MAX_CRUISE_SPEED)
      bits |= COMMAND_BITS.thrust;
    else if (targetDistance <= CHASE_DISTANCE && speed > 80)
      bits |= COMMAND_BITS.brake;
    return bits;
  }
}
