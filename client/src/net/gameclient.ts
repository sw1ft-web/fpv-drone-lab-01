import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BULLET,
  MAX_INPUTS_PER_MESSAGE,
  SIM_STEP,
  SNAPSHOT_FLAGS,
  STEPS_PER_TICK,
  TAU,
  binaryCodec,
  bulletLaunch,
  commandFromBits,
  integrateBullet,
  integrateShip,
  asSeq,
  jsonCodec,
  Bus,
} from "@fpv/shared";
import type {
  CodecName,
  EntityId,
  EntityView,
  InputEntry,
  IntegrateShip,
  Seq,
  ShipKinematic,
  Snapshot,
} from "@fpv/shared";
import type { Outbound, Connection } from "./connection.ts";
import { SnapshotBuffer, wrapDelta } from "./interpolation.ts";
import { begin, end } from "../perf.ts";

const MAX_PENDING = 240; // 4 s of unacknowledged inputs: beyond that the server is gone
const SNAP_DISTANCE = 220; // corrections larger than this are teleports (respawn): do not smooth
const CORRECTION_TAU_MS = 45; // exponential decay of the visual correction (~100 ms to fade)
const PICKUP_NAMES = ["shield", "rapid-fire"] as const;

type ShipEntity = Extract<EntityView, { kind: "ship" }>;
type AsteroidEntity = Extract<EntityView, { kind: "asteroid" }>;
export type AsteroidView = AsteroidEntity;
type PickupEntity = Extract<EntityView, { kind: "pickup" }>;

/** Everything the rest of the client can react to. The payload type depends on the event name. */
export type GameEvents = {
  fired: { own: boolean };
  hit: { target: "ship" };
  exploded: {
    kind: "asteroid" | "ship";
    id: EntityId;
    x: number;
    y: number;
  };
  scoreChanged: { score: number; points: number };
};

export interface ShipView {
  id: EntityId;
  x: number;
  y: number;
  angle: number;
  hp: number;
  score: number;
  active: boolean;
  invulnerable: boolean;
  shield: boolean;
  thrust: boolean;
  own: boolean;
}
export interface BulletView {
  id: number;
  x: number;
  y: number;
  own: boolean;
}
export interface PickupView {
  kind: "pickup";
  id: EntityId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  pickupType: (typeof PICKUP_NAMES)[number];
}
/** What the renderer draws in one frame. */
export interface WorldView {
  ships: ShipView[];
  bullets: BulletView[];
  asteroids: AsteroidEntity[];
  pickups: PickupView[];
  own: ShipView | null;
}

export interface GameStats {
  rttMs: number;
  snapshots: number;
  snapshotAgeMs: number;
  lastSnapshotAt: number;
  correctionPx: number;
  maxCorrectionPx: number;
  reconciliations: number;
  mispredictions: number;
  teleports: number;
  inputsSent: number;
  badFrames: number;
  bytesIn: number;
}

/** An input the server has not acknowledged yet. */
interface PendingInput {
  seq: Seq;
  bits: number;
  at: number;
}

/** A bullet the local ship fired; it lives until the server's copy takes over. */
interface PredictedBullet {
  fireSeq: Seq;
  /** Same shape as the server's Bullet, so `integrateBullet` can advance it directly. */
  readonly pos: { x: number; y: number };
  readonly vel: { x: number; y: number };
  ttl: number;
  seenOnServer: boolean;
  missingSince: number | null;
}

export interface GameClientOptions {
  connection?: Connection | null;
  welcome: {
    shipId: EntityId;
    codec?: CodecName;
    arena?: { width: number; height: number };
  };
  codec?: CodecName;
  now?: () => number;
  send?: ((frame: Outbound) => void) | null;
  interpolationDelayMs?: number;
  integrate?: IntegrateShip;
}

/**
 * The client half of the netcode.
 *
 *  - client-side prediction: every 60 Hz step the local ship is moved with the
 *    same `integrateShip` the server runs, without waiting for the network;
 *  - reconciliation: when a snapshot arrives the ship is reset to the server's
 *    state, inputs the server has not seen yet (seq > ack) are replayed on top,
 *    and the visual difference is faded out instead of snapped;
 *  - interpolation: everything that is not the local ship is drawn ~100 ms in
 *    the past between two snapshots (see SnapshotBuffer);
 *  - the local ship's own bullets are predicted and matched to the server's
 *    copies by `fireSeq`.
 *
 * No DOM, no timers: `now` is injectable so the whole thing runs headless.
 */
export class GameClient {
  readonly events = new Bus<GameEvents>();
  readonly connection: Connection | null;
  readonly now: () => number;
  readonly codecName: CodecName;
  readonly codec: typeof binaryCodec | typeof jsonCodec;
  readonly sendFrame: (frame: Outbound) => void;
  readonly width: number;
  readonly height: number;
  readonly interpolationDelayMs: number;
  readonly integrate: IntegrateShip;
  unsubscribe: (() => void)[] = [];

  shipId: EntityId;
  buffer: SnapshotBuffer;
  nextSeq = 1;
  pending: PendingInput[] = [];
  ack = 0;
  /** Predicted state, created from the first snapshot. */
  ship: ShipKinematic | null = null;
  previous: { x: number; y: number; angle: number } | null = null;
  correction = { x: 0, y: 0 };
  lastViewAt: number;
  fireCooldown = 0;
  rapidFire = false;
  bullets: PredictedBullet[] = [];
  /** Last known own entity. */
  serverState: ShipEntity | null = null;
  /** Entities of the previous snapshot, to detect events. */
  known = new Map<EntityId, EntityView>();
  stats: GameStats = emptyStats();

  constructor({
    connection = null,
    welcome,
    codec = welcome.codec ?? "json",
    now = () => performance.now(),
    send = null,
    interpolationDelayMs = 100,
    integrate = integrateShip,
  }: GameClientOptions) {
    this.connection = connection;
    this.now = now;
    this.codecName = codec;
    this.codec = codec === "binary" ? binaryCodec : jsonCodec;
    this.sendFrame =
      send ??
      ((frame) => {
        connection?.send(frame);
      });
    this.width = welcome.arena?.width ?? ARENA_WIDTH;
    this.height = welcome.arena?.height ?? ARENA_HEIGHT;
    this.interpolationDelayMs = interpolationDelayMs;
    this.integrate = integrate;
    this.shipId = welcome.shipId;
    this.buffer = this.#newBuffer();
    this.lastViewAt = this.now();
    this.reset(welcome.shipId);

    if (connection) {
      this.unsubscribe = [
        connection.on("snapshot", (message, size) =>
          this.ingest(message, size),
        ),
        connection.onBinary((bytes, size) => {
          try {
            const started = begin();
            const snapshot = binaryCodec.decodeSnapshot(bytes);
            end("decode", started);
            this.ingest(snapshot, size);
          } catch {
            this.stats.badFrames += 1;
          }
        }),
        connection.on("welcome", (message) => this.reset(message.shipId)),
      ];
    }
  }

  #newBuffer(): SnapshotBuffer {
    return new SnapshotBuffer({
      delayMs: this.interpolationDelayMs,
      width: this.width,
      height: this.height,
    });
  }

  reset(shipId: EntityId): void {
    this.shipId = shipId;
    this.buffer = this.#newBuffer();
    this.nextSeq = 1;
    this.pending = [];
    this.ack = 0;
    this.ship = null;
    this.previous = null;
    this.correction = { x: 0, y: 0 };
    this.lastViewAt = this.now();
    this.fireCooldown = 0;
    this.rapidFire = false;
    this.bullets = [];
    this.serverState = null;
    this.known = new Map();
    this.stats = emptyStats();
  }

  destroy(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  get ready(): boolean {
    return this.ship !== null;
  }

  // ---------------------------------------------------------------- inputs

  /** Runs one 60 Hz simulation step for the local ship with input `bits`. */
  step(bits: number): Seq {
    const seq = asSeq(this.nextSeq++);
    this.pending.push({ seq, bits, at: this.now() });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    if (this.ship) {
      const previous = (this.previous ??= { x: 0, y: 0, angle: 0 });
      previous.x = this.ship.pos.x;
      previous.y = this.ship.pos.y;
      previous.angle = this.ship.angle;
      this.#advanceBullets();
      if (this.alive) this.#applyCommand(this.ship, bits, seq, true);
    }
    if (seq % STEPS_PER_TICK === 0) this.flush();
    return seq;
  }

  /** Sends every input the server has not acknowledged yet (up to 16): redundancy covers lost messages. */
  flush(): void {
    if (this.connection && this.connection.state !== "open") return;
    const inputs: InputEntry[] = this.pending
      .slice(-MAX_INPUTS_PER_MESSAGE)
      .map(({ seq, bits }) => ({ seq, bits }));
    if (inputs.length === 0) return;
    this.sendFrame(
      this.codecName === "binary"
        ? binaryCodec.encodeInput({ inputs })
        : { type: "input", inputs },
    );
    this.stats.inputsSent += 1;
  }

  get alive(): boolean {
    return this.ship !== null && this.serverState
      ? (this.serverState.flags & SNAPSHOT_FLAGS.ACTIVE) !== 0
      : this.ship !== null;
  }

  #applyCommand(
    ship: ShipKinematic,
    bits: number,
    seq: Seq,
    live: boolean,
  ): void {
    const command = commandFromBits(bits);
    if (live) this.fireCooldown = Math.max(0, this.fireCooldown - SIM_STEP);
    this.integrate(ship, command, SIM_STEP, this.width, this.height);
    if (command.fire && live && this.fireCooldown === 0) {
      const { pos, vel } = bulletLaunch(ship);
      this.bullets.push({
        fireSeq: seq,
        pos: { x: pos.x, y: pos.y },
        vel: { x: vel.x, y: vel.y },
        ttl: BULLET.ttl,
        seenOnServer: false,
        missingSince: null,
      });
      this.fireCooldown = this.rapidFire
        ? BULLET.rapidCooldown
        : BULLET.cooldown;
      this.events.emit("fired", { own: true });
    }
  }

  /** Advances and expires predicted bullets in place (no new array, no per-bullet temporaries). */
  #advanceBullets(): void {
    let kept = 0;
    for (const bullet of this.bullets) {
      bullet.ttl -= SIM_STEP;
      if (bullet.ttl <= 0) continue;
      integrateBullet(bullet, SIM_STEP, this.width, this.height);
      this.bullets[kept] = bullet;
      kept += 1;
    }
    this.bullets.length = kept;
  }

  // -------------------------------------------------------------- snapshots

  /** Handles one decoded snapshot {tick, ack, entities}. */
  ingest(snapshot: Snapshot, byteLength = 0): void {
    const receivedAt = this.now();
    if (!this.buffer.push(snapshot, receivedAt)) return;
    this.stats.snapshots += 1;
    this.stats.bytesIn += byteLength;
    this.stats.lastSnapshotAt = receivedAt;

    this.#emitEvents(snapshot);
    const own = snapshot.entities.find(
      (e): e is ShipEntity => e.kind === "ship" && e.id === this.shipId,
    );
    if (own) {
      const started = begin();
      this.#reconcile(own, snapshot.ack, receivedAt);
      end("reconcile", started);
    }
    this.#matchBullets(snapshot);
  }

  #reconcile(own: ShipEntity, ack: Seq, receivedAt: number): void {
    const acked = this.pending.find((p) => p.seq === ack);
    if (acked && ack > this.ack)
      this.stats.rttMs =
        this.stats.rttMs === 0
          ? receivedAt - acked.at
          : this.stats.rttMs * 0.8 + (receivedAt - acked.at) * 0.2;
    this.ack = Math.max(this.ack, ack);
    this.pending = this.pending.filter((p) => p.seq > ack);
    this.serverState = own;
    this.rapidFire = (own.flags & SNAPSHOT_FLAGS.RAPID_FIRE) !== 0;

    const shown = this.ship ? this.#displayPosition(this.ship) : null;
    const state: ShipKinematic = {
      pos: { x: own.x, y: own.y },
      vel: { x: own.vx, y: own.vy },
      angle: own.angle,
      thrust: (own.flags & SNAPSHOT_FLAGS.THRUST) !== 0 ? 1 : 0,
    };
    const active = (own.flags & SNAPSHOT_FLAGS.ACTIVE) !== 0;
    if (active) {
      for (const input of this.pending)
        this.#applyCommand(state, input.bits, input.seq, false);
    }

    if (shown) {
      const dx = wrapDelta(state.pos.x, shown.x, this.width);
      const dy = wrapDelta(state.pos.y, shown.y, this.height);
      const error = Math.hypot(dx, dy);
      this.stats.reconciliations += 1;
      this.stats.correctionPx = error;
      if (error > SNAP_DISTANCE || !active) {
        if (active) this.stats.teleports += 1;
        this.stats.correctionPx = 0;
        this.correction = { x: 0, y: 0 };
      } else {
        if (error > 0.5) this.stats.mispredictions += 1;
        this.stats.maxCorrectionPx = Math.max(
          this.stats.maxCorrectionPx,
          error,
        );
        this.correction = { x: dx, y: dy };
      }
    }
    this.ship = state;
    this.previous = { ...state.pos, angle: state.angle };
  }

  /** Predicted bullets live until the server shows (and later removes) the real one. */
  #matchBullets(snapshot: Snapshot): void {
    const mine = new Set<Seq>();
    for (const e of snapshot.entities)
      if (e.kind === "bullet" && e.ownerId === this.shipId) mine.add(e.fireSeq);
    this.bullets = this.bullets.filter((bullet) => {
      if (mine.has(bullet.fireSeq)) {
        bullet.seenOnServer = true;
        return true;
      }
      if (bullet.seenOnServer) return false; // the server removed it: it hit something or expired
      // Acknowledged but never appeared: the server refused the shot (cooldown / dead).
      return bullet.fireSeq > this.ack;
    });
  }

  #emitEvents(snapshot: Snapshot): void {
    const next = new Map(snapshot.entities.map((e) => [e.id, e]));
    for (const [id, previous] of this.known) {
      const current = next.get(id);
      if (previous.kind === "asteroid" && !current)
        this.events.emit("exploded", {
          kind: "asteroid",
          id,
          x: previous.x,
          y: previous.y,
        });
      if (previous.kind === "ship" && current?.kind === "ship") {
        const wasActive = previous.flags & SNAPSHOT_FLAGS.ACTIVE;
        const isActive = current.flags & SNAPSHOT_FLAGS.ACTIVE;
        if (wasActive && !isActive)
          this.events.emit("exploded", {
            kind: "ship",
            id,
            x: previous.x,
            y: previous.y,
          });
        if (id === this.shipId) {
          if (current.hp < previous.hp && isActive)
            this.events.emit("hit", { target: "ship" });
          if (current.score !== previous.score)
            this.events.emit("scoreChanged", {
              score: current.score,
              points: current.score - previous.score,
            });
        }
      }
    }
    for (const e of snapshot.entities) {
      if (
        e.kind === "bullet" &&
        e.ownerId !== this.shipId &&
        !this.known.has(e.id)
      )
        this.events.emit("fired", { own: false });
    }
    this.known = next;
  }

  // ------------------------------------------------------------------ view

  #displayPosition(ship: ShipKinematic): { x: number; y: number } {
    return {
      x: ship.pos.x + this.correction.x,
      y: ship.pos.y + this.correction.y,
    };
  }

  /**
   * Everything the renderer needs at client time `now`.
   * `alpha` (0..1) is the fraction of the current 60 Hz step, used to smooth the
   * predicted ship between simulation steps.
   */
  view(alpha = 1, now = this.now()): WorldView {
    const elapsed = Math.max(0, now - this.lastViewAt);
    this.lastViewAt = now;
    const decay = Math.exp(-elapsed / CORRECTION_TAU_MS);
    this.correction.x *= decay;
    this.correction.y *= decay;
    this.stats.snapshotAgeMs = this.stats.lastSnapshotAt
      ? now - this.stats.lastSnapshotAt
      : 0;

    const { list } = this.buffer.sample(now);
    // One WorldView and its entries are reused every frame (see `#slots`): the
    // renderer reads them synchronously, so nothing is allocated per frame.
    const view = this.#view;
    view.ships.length = 0;
    view.bullets.length = 0;
    view.asteroids.length = 0;
    view.pickups.length = 0;
    view.own = null;
    const used = this.#used;
    used.ships = 0;
    used.bullets = 0;
    used.pickups = 0;
    for (let i = 0; i < list.length; i += 1) {
      const entity = list[i];
      if (!entity) continue;
      if (entity.kind === "ship") {
        if (entity.id === this.shipId) continue;
        view.ships.push(this.#shipView(entity, false));
      } else if (entity.kind === "bullet") {
        if (entity.ownerId === this.shipId) continue; // drawn from the predicted copy
        view.bullets.push(
          this.#bulletView(entity.id, entity.x, entity.y, false),
        );
      } else if (entity.kind === "asteroid") {
        view.asteroids.push(entity);
      } else {
        view.pickups.push(this.#pickupView(entity));
      }
    }
    for (const bullet of this.bullets)
      view.bullets.push(
        this.#bulletView(0 - bullet.fireSeq, bullet.pos.x, bullet.pos.y, true),
      );

    if (this.ship && this.serverState) {
      const previous = this.previous ?? {
        ...this.ship.pos,
        angle: this.ship.angle,
      };
      const dx = wrapDelta(previous.x, this.ship.pos.x, this.width);
      const dy = wrapDelta(previous.y, this.ship.pos.y, this.height);
      const turn = wrapDelta(previous.angle, this.ship.angle, TAU);
      view.own = this.#shipView(
        this.serverState,
        true,
        this.#wrap(previous.x + dx * alpha + this.correction.x, this.width),
        this.#wrap(previous.y + dy * alpha + this.correction.y, this.height),
        previous.angle + turn * alpha,
        (this.serverState.flags & ~SNAPSHOT_FLAGS.THRUST) |
          (this.ship.thrust ? SNAPSHOT_FLAGS.THRUST : 0),
      );
      view.ships.push(view.own);
    }
    return view;
  }

  #wrap(value: number, size: number): number {
    return ((value % size) + size) % size;
  }

  readonly #view: WorldView = {
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    own: null,
  };
  /** Object pools behind `#view`: grown on demand, then reused forever. */
  readonly #slots: {
    ships: ShipView[];
    bullets: BulletView[];
    pickups: PickupView[];
  } = { ships: [], bullets: [], pickups: [] };
  readonly #used = { ships: 0, bullets: 0, pickups: 0 };

  #shipView(
    entity: ShipEntity,
    own: boolean,
    x = entity.x,
    y = entity.y,
    angle = entity.angle,
    flags = entity.flags,
  ): ShipView {
    const slots = this.#slots.ships;
    let view = slots[this.#used.ships];
    if (!view) {
      view = {
        id: entity.id,
        x: 0,
        y: 0,
        angle: 0,
        hp: 0,
        score: 0,
        active: false,
        invulnerable: false,
        shield: false,
        thrust: false,
        own: false,
      };
      slots.push(view);
    }
    this.#used.ships += 1;
    view.id = entity.id;
    view.x = x;
    view.y = y;
    view.angle = angle;
    view.hp = entity.hp;
    view.score = entity.score;
    view.active = (flags & SNAPSHOT_FLAGS.ACTIVE) !== 0;
    view.invulnerable = (flags & SNAPSHOT_FLAGS.INVULNERABLE) !== 0;
    view.shield = (flags & SNAPSHOT_FLAGS.SHIELD) !== 0;
    view.thrust = (flags & SNAPSHOT_FLAGS.THRUST) !== 0;
    view.own = own;
    return view;
  }

  #bulletView(id: number, x: number, y: number, own: boolean): BulletView {
    const slots = this.#slots.bullets;
    let view = slots[this.#used.bullets];
    if (!view) {
      view = { id, x, y, own };
      slots.push(view);
    }
    this.#used.bullets += 1;
    view.id = id;
    view.x = x;
    view.y = y;
    view.own = own;
    return view;
  }

  #pickupView(entity: PickupEntity): PickupView {
    const slots = this.#slots.pickups;
    let view = slots[this.#used.pickups];
    if (!view) {
      view = { ...entity, pickupType: PICKUP_NAMES[entity.pickupType] };
      slots.push(view);
    }
    this.#used.pickups += 1;
    view.id = entity.id;
    view.x = entity.x;
    view.y = entity.y;
    view.vx = entity.vx;
    view.vy = entity.vy;
    view.angle = entity.angle;
    view.pickupType = PICKUP_NAMES[entity.pickupType];
    return view;
  }

  /** Numbers for the netgraph. `bytesIn` is cumulative; the overlay turns it into a rate. */
  netStats(): NetStats {
    return {
      ...this.stats,
      pendingInputs: this.pending.length,
      interpolationDelayMs: this.buffer.delayMs,
      clockOffsetMs: this.buffer.clockOffset,
    };
  }
}

export interface NetStats extends GameStats {
  pendingInputs: number;
  interpolationDelayMs: number;
  clockOffsetMs: number;
}

function emptyStats(): GameStats {
  return {
    rttMs: 0,
    snapshots: 0,
    snapshotAgeMs: 0,
    lastSnapshotAt: 0,
    correctionPx: 0,
    maxCorrectionPx: 0,
    reconciliations: 0,
    mispredictions: 0,
    teleports: 0,
    inputsSent: 0,
    badFrames: 0,
    bytesIn: 0,
  };
}
