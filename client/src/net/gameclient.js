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
  jsonCodec,
} from "@fpv/shared";
import { SnapshotBuffer, wrapDelta } from "./interpolation.js";

const MAX_PENDING = 240; // 4 s of unacknowledged inputs: beyond that the server is gone
const SNAP_DISTANCE = 220; // corrections larger than this are teleports (respawn): do not smooth
const CORRECTION_TAU_MS = 45; // exponential decay of the visual correction (~100 ms to fade)
const PICKUP_NAMES = ["shield", "rapid-fire"];

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
export class GameClient extends EventTarget {
  constructor({
    connection = null,
    welcome,
    codec = welcome.codec ?? "json",
    now = () => performance.now(),
    send = null,
    interpolationDelayMs = 100,
    integrate = integrateShip,
  }) {
    super();
    this.connection = connection;
    this.now = now;
    this.codecName = codec;
    this.codec = codec === "binary" ? binaryCodec : jsonCodec;
    this.sendFrame = send ?? ((frame) => connection?.send(frame));
    this.width = welcome.arena?.width ?? ARENA_WIDTH;
    this.height = welcome.arena?.height ?? ARENA_HEIGHT;
    this.interpolationDelayMs = interpolationDelayMs;
    this.integrate = integrate;
    this.reset(welcome.shipId);

    if (connection) {
      this.unsubscribe = [
        connection.on("snapshot", (message, size) =>
          this.ingest(message, size),
        ),
        connection.onBinary((bytes, size) => {
          try {
            this.ingest(binaryCodec.decodeSnapshot(bytes), size);
          } catch {
            this.stats.badFrames += 1;
          }
        }),
        connection.on("welcome", (message) => this.reset(message.shipId)),
      ];
    }
  }

  reset(shipId) {
    this.shipId = shipId;
    this.buffer = new SnapshotBuffer({
      delayMs: this.interpolationDelayMs,
      width: this.width,
      height: this.height,
    });
    this.nextSeq = 1;
    this.pending = [];
    this.ack = 0;
    this.ship = null; // predicted state, created from the first snapshot
    this.previous = null;
    this.correction = { x: 0, y: 0 };
    this.lastViewAt = this.now();
    this.fireCooldown = 0;
    this.rapidFire = false;
    this.bullets = [];
    this.serverState = null; // last known own entity
    this.known = new Map(); // entity ids of the previous snapshot, for events
    this.stats = {
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

  destroy() {
    for (const off of this.unsubscribe ?? []) off();
    this.unsubscribe = [];
  }

  get ready() {
    return this.ship !== null;
  }

  // ---------------------------------------------------------------- inputs

  /** Runs one 60 Hz simulation step for the local ship with input `bits`. */
  step(bits) {
    const seq = this.nextSeq++;
    this.pending.push({ seq, bits, at: this.now() });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    if (this.ship) {
      this.previous = { ...this.ship.pos, angle: this.ship.angle };
      this.#advanceBullets();
      if (this.alive) this.#applyCommand(this.ship, bits, seq, true);
    }
    if (seq % STEPS_PER_TICK === 0) this.flush();
    return seq;
  }

  /** Sends every input the server has not acknowledged yet (up to 16): redundancy covers lost messages. */
  flush() {
    if (this.connection && this.connection.state !== "open") return;
    const inputs = this.pending
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

  get alive() {
    return this.ship !== null && this.serverState
      ? (this.serverState.flags & SNAPSHOT_FLAGS.ACTIVE) !== 0
      : this.ship !== null;
  }

  #applyCommand(ship, bits, seq, live) {
    const command = commandFromBits(bits);
    if (live) this.fireCooldown = Math.max(0, this.fireCooldown - SIM_STEP);
    this.integrate(ship, command, SIM_STEP, this.width, this.height);
    if (command.fire && live && this.fireCooldown === 0) {
      const { pos, vel } = bulletLaunch(ship);
      this.bullets.push({
        fireSeq: seq,
        x: pos.x,
        y: pos.y,
        vx: vel.x,
        vy: vel.y,
        ttl: BULLET.ttl,
        seenOnServer: false,
        missingSince: null,
      });
      this.fireCooldown = this.rapidFire
        ? BULLET.rapidCooldown
        : BULLET.cooldown;
      this.dispatchEvent(new CustomEvent("fired", { detail: { own: true } }));
    }
  }

  #advanceBullets() {
    for (const bullet of this.bullets) {
      bullet.ttl -= SIM_STEP;
      const holder = { pos: { x: bullet.x, y: bullet.y }, vel: bullet };
      integrateBullet(holder, SIM_STEP, this.width, this.height);
      bullet.x = holder.pos.x;
      bullet.y = holder.pos.y;
    }
    this.bullets = this.bullets.filter((b) => b.ttl > 0);
  }

  // -------------------------------------------------------------- snapshots

  /** Handles one decoded snapshot {tick, ack, entities}. */
  ingest(snapshot, byteLength = 0) {
    const receivedAt = this.now();
    if (!this.buffer.push(snapshot, receivedAt)) return;
    this.stats.snapshots += 1;
    this.stats.bytesIn += byteLength;
    this.stats.lastSnapshotAt = receivedAt;

    this.#emitEvents(snapshot);
    const own = snapshot.entities.find((e) => e.id === this.shipId);
    if (own) this.#reconcile(own, snapshot.ack, receivedAt);
    this.#matchBullets(snapshot);
  }

  #reconcile(own, ack, receivedAt) {
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

    const shown = this.ship ? this.#displayPosition() : null;
    const state = {
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
  #matchBullets(snapshot) {
    const mine = new Set();
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

  #emitEvents(snapshot) {
    const next = new Map(snapshot.entities.map((e) => [e.id, e]));
    for (const [id, previous] of this.known) {
      const current = next.get(id);
      if (previous.kind === "asteroid" && !current)
        this.#emit("exploded", {
          kind: "asteroid",
          id,
          x: previous.x,
          y: previous.y,
        });
      if (previous.kind === "ship" && current) {
        const wasActive = previous.flags & SNAPSHOT_FLAGS.ACTIVE;
        const isActive = current.flags & SNAPSHOT_FLAGS.ACTIVE;
        if (wasActive && !isActive)
          this.#emit("exploded", {
            kind: "ship",
            id,
            x: previous.x,
            y: previous.y,
          });
        if (id === this.shipId) {
          if (current.hp < previous.hp && isActive)
            this.#emit("hit", { target: "ship" });
          if (current.score !== previous.score)
            this.#emit("scoreChanged", {
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
        this.#emit("fired", { own: false });
    }
    this.known = next;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ------------------------------------------------------------------ view

  #displayPosition() {
    return {
      x: this.ship.pos.x + this.correction.x,
      y: this.ship.pos.y + this.correction.y,
    };
  }

  /**
   * Everything the renderer needs at client time `now`.
   * `alpha` (0..1) is the fraction of the current 60 Hz step, used to smooth the
   * predicted ship between simulation steps.
   */
  view(alpha = 1, now = this.now()) {
    const elapsed = Math.max(0, now - this.lastViewAt);
    this.lastViewAt = now;
    const decay = Math.exp(-elapsed / CORRECTION_TAU_MS);
    this.correction.x *= decay;
    this.correction.y *= decay;
    this.stats.snapshotAgeMs = this.stats.lastSnapshotAt
      ? now - this.stats.lastSnapshotAt
      : 0;

    const { entities } = this.buffer.sample(now);
    const view = {
      ships: [],
      bullets: [],
      asteroids: [],
      pickups: [],
      own: null,
    };
    for (const entity of entities.values()) {
      if (entity.kind === "ship") {
        if (entity.id === this.shipId) continue;
        view.ships.push(this.#shipView(entity, false));
      } else if (entity.kind === "bullet") {
        if (entity.ownerId === this.shipId) continue; // drawn from the predicted copy
        view.bullets.push({
          id: entity.id,
          x: entity.x,
          y: entity.y,
          own: false,
        });
      } else if (entity.kind === "asteroid") {
        view.asteroids.push(entity);
      } else if (entity.kind === "pickup") {
        view.pickups.push({
          ...entity,
          pickupType: PICKUP_NAMES[entity.pickupType] ?? "shield",
        });
      }
    }
    for (const bullet of this.bullets)
      view.bullets.push({
        id: -bullet.fireSeq,
        x: bullet.x,
        y: bullet.y,
        own: true,
      });

    if (this.ship && this.serverState) {
      const previous = this.previous ?? {
        ...this.ship.pos,
        angle: this.ship.angle,
      };
      const dx = wrapDelta(previous.x, this.ship.pos.x, this.width);
      const dy = wrapDelta(previous.y, this.ship.pos.y, this.height);
      const turn = wrapDelta(previous.angle, this.ship.angle, TAU);
      view.own = this.#shipView(
        {
          ...this.serverState,
          x: this.#wrap(
            previous.x + dx * alpha + this.correction.x,
            this.width,
          ),
          y: this.#wrap(
            previous.y + dy * alpha + this.correction.y,
            this.height,
          ),
          angle: previous.angle + turn * alpha,
          flags:
            (this.serverState.flags & ~SNAPSHOT_FLAGS.THRUST) |
            (this.ship.thrust ? SNAPSHOT_FLAGS.THRUST : 0),
        },
        true,
      );
      view.ships.push(view.own);
    }
    return view;
  }

  #wrap(value, size) {
    return ((value % size) + size) % size;
  }

  #shipView(entity, own) {
    return {
      id: entity.id,
      x: entity.x,
      y: entity.y,
      angle: entity.angle,
      hp: entity.hp,
      score: entity.score,
      active: (entity.flags & SNAPSHOT_FLAGS.ACTIVE) !== 0,
      invulnerable: (entity.flags & SNAPSHOT_FLAGS.INVULNERABLE) !== 0,
      shield: (entity.flags & SNAPSHOT_FLAGS.SHIELD) !== 0,
      thrust: (entity.flags & SNAPSHOT_FLAGS.THRUST) !== 0,
      own,
    };
  }

  /** Numbers for the netgraph. `bytesIn` is cumulative; the overlay turns it into a rate. */
  netStats() {
    return {
      ...this.stats,
      pendingInputs: this.pending.length,
      interpolationDelayMs: this.buffer.delayMs,
      clockOffsetMs: this.buffer.clockOffset,
    };
  }
}
