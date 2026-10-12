import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  SNAPSHOT_FLAGS,
  TAU,
  TICK_MS,
} from "@fpv/shared";

const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed difference on a ring of length `size`. */
export function wrapDelta(from, to, size) {
  let delta = to - from;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  return delta;
}

export function lerpAngle(a, b, t) {
  return a + wrapDelta(a, b, TAU) * t;
}

/**
 * Entity interpolation. Remote entities are drawn `delayMs` in the past,
 * between the two snapshots that surround that moment, so a lost or late
 * snapshot does not make them jump.
 *
 * Server and client clocks are unrelated, so we never compare them directly.
 * For every snapshot we record `receivedAt - serverTime`; this equals
 * `offset + networkDelay`, and network delay is never negative, so the MINIMUM
 * over a sliding window is the best estimate of the offset (jitter only ever
 * adds to it).
 */
export class SnapshotBuffer {
  #snapshots = [];
  #offsets = [];

  constructor({
    delayMs = 100,
    windowSize = 150,
    maxSnapshots = 64,
    width = ARENA_WIDTH,
    height = ARENA_HEIGHT,
  } = {}) {
    this.delayMs = delayMs;
    this.windowSize = windowSize;
    this.maxSnapshots = maxSnapshots;
    this.width = width;
    this.height = height;
  }

  get size() {
    return this.#snapshots.length;
  }

  get latest() {
    return this.#snapshots.at(-1) ?? null;
  }

  clear() {
    this.#snapshots.length = 0;
    this.#offsets.length = 0;
  }

  push(snapshot, receivedAt) {
    const last = this.#snapshots.at(-1);
    if (last && snapshot.tick <= last.tick) return false; // late or duplicate
    const time = snapshot.tick * TICK_MS;
    this.#snapshots.push({ ...snapshot, time, receivedAt });
    if (this.#snapshots.length > this.maxSnapshots) this.#snapshots.shift();
    this.#offsets.push(receivedAt - time);
    if (this.#offsets.length > this.windowSize) this.#offsets.shift();
    return true;
  }

  get clockOffset() {
    return this.#offsets.length ? Math.min(...this.#offsets) : 0;
  }

  /** The server time we are drawing at the client time `now`. */
  renderTime(now) {
    return now - this.clockOffset - this.delayMs;
  }

  /**
   * Interpolated entities (a Map id -> view) at client time `now`.
   * Entities that only exist in the later snapshot are not shown yet; entities
   * that only exist in the earlier one are shown until the later one is reached.
   */
  sample(now) {
    const list = this.#snapshots;
    if (list.length === 0) return { entities: new Map(), alpha: 0 };
    const time = this.renderTime(now);

    if (time <= list[0].time || list.length === 1) {
      return { entities: this.#toMap(list[0]), alpha: 0 };
    }
    const last = list.at(-1);
    if (time >= last.time) {
      return {
        entities: this.#extrapolate(last, time - last.time),
        alpha: 1,
        starved: true,
      };
    }
    let index = list.length - 2;
    while (index > 0 && list[index].time > time) index -= 1;
    const from = list[index];
    const to = list[index + 1];
    const alpha = (time - from.time) / (to.time - from.time);
    const targets = new Map(to.entities.map((e) => [e.id, e]));
    const entities = new Map();
    for (const a of from.entities) {
      const b = targets.get(a.id);
      entities.set(a.id, b ? this.#blend(a, b, alpha) : { ...a });
    }
    return { entities, alpha, starved: false };
  }

  #toMap(snapshot) {
    return new Map(snapshot.entities.map((e) => [e.id, { ...e }]));
  }

  /** Past the newest snapshot we keep moving for a short while, then hold. */
  #extrapolate(snapshot, overshootMs) {
    const seconds = Math.min(overshootMs, 150) / 1000;
    const entities = new Map();
    for (const e of snapshot.entities) {
      const view = { ...e };
      if (e.kind !== "pickup") {
        view.x =
          (((e.x + e.vx * seconds) % this.width) + this.width) % this.width;
        view.y =
          (((e.y + e.vy * seconds) % this.height) + this.height) % this.height;
      }
      entities.set(e.id, view);
    }
    return entities;
  }

  #blend(a, b, t) {
    const view = { ...b };
    // A ship that died or respawned teleports: never slide it across the arena.
    if (
      a.kind === "ship" &&
      (((a.flags ^ b.flags) & SNAPSHOT_FLAGS.ACTIVE) !== 0 ||
        (b.flags & SNAPSHOT_FLAGS.ACTIVE) === 0)
    )
      return view;
    view.x =
      (a.x + wrapDelta(a.x, b.x, this.width) * t + this.width) % this.width;
    view.y =
      (a.y + wrapDelta(a.y, b.y, this.height) * t + this.height) % this.height;
    view.angle = lerpAngle(a.angle, b.angle, t);
    view.vx = lerp(a.vx, b.vx, t);
    view.vy = lerp(a.vy, b.vy, t);
    return view;
  }
}
