import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  SNAPSHOT_FLAGS,
  TAU,
  TICK_MS,
} from "@fpv/shared";
import type { EntityId, EntityView, Snapshot } from "@fpv/shared";

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableView = Mutable<EntityView>;

/** Overwrites `dst` with `src` field by field (same kind), so a pooled view keeps its shape. */
function copyInto(dst: MutableView, src: EntityView): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.angle = src.angle;
  if (dst.kind === "ship" && src.kind === "ship") {
    dst.hp = src.hp;
    dst.score = src.score;
    dst.flags = src.flags;
  } else if (dst.kind === "bullet" && src.kind === "bullet") {
    dst.ownerId = src.ownerId;
    dst.fireSeq = src.fireSeq;
  } else if (dst.kind === "asteroid" && src.kind === "asteroid") {
    dst.radius = src.radius;
    dst.homing = src.homing;
  } else if (dst.kind === "pickup" && src.kind === "pickup") {
    dst.pickupType = src.pickupType;
  }
}

/** A snapshot as the buffer stores it: with its server time and arrival time. */
export interface TimedSnapshot extends Snapshot {
  readonly time: number;
  readonly receivedAt: number;
}

export interface BufferOptions {
  delayMs?: number;
  windowSize?: number;
  maxSnapshots?: number;
  width?: number;
  height?: number;
}

export interface Sample {
  /** The interpolated entities, in snapshot order. Reused: valid until the next `sample()` call. */
  readonly list: readonly EntityView[];
  /** The same entities by id. Built on demand (allocates), for tests and tooling; the renderer uses `list`. */
  readonly entities: Map<EntityId, EntityView>;
  alpha: number;
  /** True when the render time is past the newest snapshot (we are extrapolating). */
  starved: boolean;
}

/** Shortest signed difference on a ring of length `size`. */
export function wrapDelta(from: number, to: number, size: number): number {
  let delta = to - from;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  return delta;
}

export function lerpAngle(a: number, b: number, t: number): number {
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
  readonly #snapshots: TimedSnapshot[] = [];
  readonly #offsets: number[] = [];
  #minOffset = 0;
  /**
   * Reused between calls: `sample()` runs every frame, so it must not allocate
   * a Map plus one object per entity each time (see docs/lab-07.md, "after").
   * The returned list and its views are therefore only valid until the next call.
   */
  readonly #list: EntityView[] = [];
  readonly #pool = new Map<EntityId, MutableView>();
  readonly #sample: Mutable<Sample>;
  #samples = 0;
  delayMs: number;
  readonly windowSize: number;
  readonly maxSnapshots: number;
  readonly width: number;
  readonly height: number;

  constructor({
    delayMs = 100,
    windowSize = 150,
    maxSnapshots = 64,
    width = ARENA_WIDTH,
    height = ARENA_HEIGHT,
  }: BufferOptions = {}) {
    this.delayMs = delayMs;
    this.windowSize = windowSize;
    this.maxSnapshots = maxSnapshots;
    this.width = width;
    this.height = height;
    const list = this.#list;
    this.#sample = {
      list,
      get entities() {
        return new Map(list.map((entity) => [entity.id, entity]));
      },
      alpha: 0,
      starved: false,
    };
  }

  get size(): number {
    return this.#snapshots.length;
  }

  get latest(): TimedSnapshot | null {
    return this.#snapshots.at(-1) ?? null;
  }

  clear(): void {
    this.#snapshots.length = 0;
    this.#offsets.length = 0;
    this.#minOffset = 0;
    this.#list.length = 0;
    this.#pool.clear();
  }

  push(snapshot: Snapshot, receivedAt: number): boolean {
    const last = this.#snapshots.at(-1);
    if (last && snapshot.tick <= last.tick) return false; // late or duplicate
    const time = snapshot.tick * TICK_MS;
    this.#snapshots.push({ ...snapshot, time, receivedAt });
    if (this.#snapshots.length > this.maxSnapshots) this.#snapshots.shift();
    this.#offsets.push(receivedAt - time);
    if (this.#offsets.length > this.windowSize) this.#offsets.shift();
    // Sliding-window minimum, recomputed once per snapshot (30 Hz) instead of
    // spreading the whole window into `Math.min(...)` on every read (60+ Hz).
    let min = Infinity;
    for (const offset of this.#offsets) if (offset < min) min = offset;
    this.#minOffset = min;
    return true;
  }

  get clockOffset(): number {
    return this.#offsets.length ? this.#minOffset : 0;
  }

  /** The server time we are drawing at the client time `now`. */
  renderTime(now: number): number {
    return now - this.clockOffset - this.delayMs;
  }

  /**
   * Interpolated entities (a Map id -> view) at client time `now`.
   * Entities that only exist in the later snapshot are not shown yet; entities
   * that only exist in the earlier one are shown until the later one is reached.
   */
  sample(now: number): Sample {
    const out = this.#list;
    out.length = 0;
    const result = this.#sample;
    result.alpha = 0;
    result.starved = false;
    const list = this.#snapshots;
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) return result;
    const time = this.renderTime(now);
    this.#samples += 1;

    if (time <= first.time || list.length === 1) {
      for (const e of first.entities) out.push(this.#acquire(e));
      this.#prune();
      return result;
    }
    if (time >= last.time) {
      this.#extrapolate(last, time - last.time);
      this.#prune();
      result.alpha = 1;
      result.starved = true;
      return result;
    }
    let index = list.length - 2;
    while (index > 0 && (list[index]?.time ?? 0) > time) index -= 1;
    const from = list[index];
    const to = list[index + 1];
    if (!from || !to) {
      for (const e of last.entities) out.push(this.#acquire(e));
      this.#prune();
      result.alpha = 1;
      return result;
    }
    const alpha = (time - from.time) / (to.time - from.time);
    // Snapshots list entities in a stable order, so the partner of from[i] is
    // almost always to[i]; fall back to a scan when an entity appeared or vanished.
    const targets = to.entities;
    for (let i = 0; i < from.entities.length; i += 1) {
      const a = from.entities[i];
      if (!a) continue;
      let b = targets[i];
      if (b?.id !== a.id)
        b = targets.find((candidate) => candidate.id === a.id);
      const view = this.#acquire(a);
      if (b) this.#blend(view, a, b, alpha);
      out.push(view);
    }
    this.#prune();
    result.alpha = alpha;
    return result;
  }

  /** The pooled view for this entity, overwritten with its current state (created on first sight or if its kind changed). */
  #acquire(source: EntityView): MutableView {
    let view = this.#pool.get(source.id);
    if (view?.kind !== source.kind) {
      view = { ...source };
      this.#pool.set(source.id, view);
    } else {
      copyInto(view, source);
    }
    return view;
  }

  /** Forget pooled views of entities that are gone (a few times a second is plenty). */
  #prune(): void {
    if (this.#samples % 120 !== 0) return;
    const alive = new Set<EntityId>();
    for (const view of this.#list) alive.add(view.id);
    for (const id of this.#pool.keys())
      if (!alive.has(id)) this.#pool.delete(id);
  }

  /** Past the newest snapshot we keep moving for a short while, then hold. */
  #extrapolate(snapshot: Snapshot, overshootMs: number): void {
    const seconds = Math.min(overshootMs, 150) / 1000;
    for (const e of snapshot.entities) {
      const view = this.#acquire(e);
      if (e.kind !== "pickup") {
        view.x =
          (((e.x + e.vx * seconds) % this.width) + this.width) % this.width;
        view.y =
          (((e.y + e.vy * seconds) % this.height) + this.height) % this.height;
      }
      this.#list.push(view);
    }
  }

  /** Writes the interpolation of a -> b into `view` (which `#acquire` already set to a's state). */
  #blend(view: MutableView, a: EntityView, b: EntityView, t: number): void {
    copyInto(view, b);
    // A ship that died or respawned teleports: never slide it across the arena.
    if (
      a.kind === "ship" &&
      b.kind === "ship" &&
      (((a.flags ^ b.flags) & SNAPSHOT_FLAGS.ACTIVE) !== 0 ||
        (b.flags & SNAPSHOT_FLAGS.ACTIVE) === 0)
    )
      return;
    view.x =
      (a.x + wrapDelta(a.x, b.x, this.width) * t + this.width) % this.width;
    view.y =
      (a.y + wrapDelta(a.y, b.y, this.height) * t + this.height) % this.height;
    view.angle = lerpAngle(a.angle, b.angle, t);
    view.vx = lerp(a.vx, b.vx, t);
    view.vy = lerp(a.vy, b.vy, t);
  }
}
