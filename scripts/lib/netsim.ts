/**
 * Headless netcode harness: the real server Match and the real client
 * GameClient, joined by LatencyInjectors on a VIRTUAL clock. No sockets, no
 * timers, no browser, so a run of 20 simulated seconds takes milliseconds and
 * is exactly repeatable.
 */
import {
  LatencyInjector,
  SNAPSHOT_FLAGS,
  SIM_STEP,
  TICK_MS,
  asSeq,
  binaryCodec,
  createRng,
  integrateShip,
  jsonCodec,
} from "../../shared/src/index.ts";
import type {
  CodecName,
  IntegrateShip,
  Snapshot,
} from "../../shared/src/index.ts";
import { GameClient } from "../../client/src/net/gameclient.ts";
import { Match } from "../../server/src/match.ts";

/** What travels on the simulated wire: JSON text or a binary frame. */
type Frame = string | Uint8Array;

export interface SessionOptions {
  seconds?: number;
  latencyMs?: number;
  jitterMs?: number;
  drop?: number;
  codec?: CodecName;
  seed?: number;
  serverIntegrate?: IntegrateShip;
  clientIntegrate?: IntegrateShip;
  interpolationDelayMs?: number;
}

interface Point {
  x: number;
  y: number;
}
interface Tracked extends Point {
  active: boolean;
}

/** The decoder is picked from the frame itself, as the real server does with `isBinary`. */
const decodeSnapshot = (frame: Frame): Snapshot =>
  typeof frame === "string"
    ? jsonCodec.decodeSnapshot(frame)
    : binaryCodec.decodeSnapshot(frame);
const decodeInput = (frame: Frame) =>
  typeof frame === "string"
    ? jsonCodec.decodeInput(frame)
    : binaryCodec.decodeInput(frame);

const STEP_MS = SIM_STEP * 1000;
const TELEPORT_PX = 100;

/** A scripted pilot: turns and thrusts in changing patterns and fires now and then. */
export function pilot(seedValue: number): () => number {
  const rng = createRng(seedValue);
  let bits = 0;
  let hold = 0;
  return () => {
    if (hold-- <= 0) {
      hold = 10 + Math.floor(rng.next() * 50);
      const turn = rng.next();
      bits =
        (turn < 0.35 ? 1 : turn < 0.7 ? 2 : 0) | (rng.next() < 0.7 ? 4 : 0);
      if (rng.next() < 0.15) bits |= 8;
    }
    return bits | (rng.next() < 0.04 ? 16 : 0);
  };
}

export function runSession({
  seconds = 20,
  latencyMs = 0,
  jitterMs = 0,
  drop = 0,
  codec = "json",
  seed = 1234,
  serverIntegrate,
  clientIntegrate = integrateShip,
  interpolationDelayMs = 100,
}: SessionOptions = {}) {
  let now = 0;
  const events: { at: number; order: number; fn: () => void }[] = [];
  let sequence = 0;
  const schedule = (fn: () => void, ms: number): void => {
    events.push({ at: now + ms, order: sequence++, fn });
  };
  const rngNet = createRng(seed ^ 0x9e3779b9);
  const network = {
    latencyMs,
    jitterMs,
    drop,
    random: () => rngNet.next(),
    schedule,
    now: () => now,
  };
  const up = new LatencyInjector(network);
  const down = new LatencyInjector(network);
  const encodeSnapshot =
    codec === "binary" ? binaryCodec.encodeSnapshot : jsonCodec.encodeSnapshot;

  let toClient: (data: Frame, size: number) => void = () => {};
  const match = new Match({
    arenaId: "arena-neon",
    seed,
    ...(serverIntegrate ? { integrate: serverIntegrate } : {}),
    onSnapshot: (playerId, snapshot) => {
      if (playerId !== "me") return;
      const frame = encodeSnapshot(snapshot);
      const size = typeof frame === "string" ? frame.length : frame.byteLength;
      stats.bytesDown += size;
      stats.snapshots += 1;
      down.send(frame, (data) => toClient(data, size));
    },
  });
  const shipId = match.addPlayer("me");
  const rivalId = match.addPlayer("rival");
  const rivalPilot = pilot(seed + 1);
  let rivalSeq = 0;

  const stats = { bytesDown: 0, bytesUp: 0, snapshots: 0, inputMessages: 0 };

  const client = new GameClient({
    welcome: { shipId, codec, arena: { width: 1600, height: 900 } },
    now: () => now,
    integrate: clientIntegrate,
    interpolationDelayMs,
    send: (frame) => {
      const payload: Frame =
        frame instanceof Uint8Array
          ? frame
          : JSON.stringify({ v: 1, ...frame });
      stats.bytesUp +=
        typeof payload === "string" ? payload.length : payload.byteLength;
      stats.inputMessages += 1;
      up.send(payload, (data) => {
        match.receiveInputs("me", decodeInput(data).inputs);
      });
    },
  });
  toClient = (data, size) => {
    client.ingest(decodeSnapshot(data), size);
  };

  const myPilot = pilot(seed);
  const remoteJump: number[] = [];
  const remoteBaselineJump: number[] = [];
  const ownJump: number[] = [];
  const metrics = { frames: 0, remoteJump, remoteBaselineJump, ownJump };
  let lastRemote: Tracked | null = null;
  let lastBaseline: Tracked | null = null;
  let lastOwn: Tracked | null = null;
  const jump = (a: Point, b: Point): number =>
    Math.hypot(
      ((b.x - a.x + 800 + 1600) % 1600) - 800,
      ((b.y - a.y + 450 + 900) % 900) - 450,
    );

  // Periodic processes on the virtual clock.
  const every = (periodMs: number, fn: (tick: number) => void): void => {
    let tick = 0;
    const run = () => {
      fn(tick++);
      schedule(run, periodMs * tick - now);
    };
    schedule(run, 0);
  };
  every(STEP_MS, () => {
    client.step(myPilot());
    // The rival is another human whose inputs arrive without delay.
    rivalSeq += 1;
    match.receiveInputs("rival", [
      { seq: asSeq(rivalSeq), bits: rivalPilot() },
    ]);
    // Render at 60 Hz right after the step (alpha = 1).
    const view = client.view(1, now);
    metrics.frames += 1;
    const remote = view.ships.find((s) => s.id === rivalId);
    if (remote) {
      if (lastRemote && lastRemote.active && remote.active)
        metrics.remoteJump.push(jump(lastRemote, remote));
      lastRemote = { x: remote.x, y: remote.y, active: remote.active };
    }
    const latest = client.buffer.latest?.entities.find(
      (e) => e.kind === "ship" && e.id === rivalId,
    );
    if (latest?.kind === "ship") {
      // Baseline "no interpolation": draw whatever snapshot arrived last.
      const active = (latest.flags & SNAPSHOT_FLAGS.ACTIVE) !== 0;
      if (lastBaseline && lastBaseline.active && active)
        metrics.remoteBaselineJump.push(jump(lastBaseline, latest));
      lastBaseline = { x: latest.x, y: latest.y, active };
    }
    if (view.own) {
      if (lastOwn && lastOwn.active && view.own.active)
        metrics.ownJump.push(jump(lastOwn, view.own));
      lastOwn = { x: view.own.x, y: view.own.y, active: view.own.active };
    }
  });
  every(TICK_MS, () => match.tick());

  const endAt = seconds * 1000;
  while (events.length) {
    let best = 0;
    for (let i = 1; i < events.length; i += 1) {
      const a = events[i];
      const b = events[best];
      if (!a || !b) continue;
      if (a.at < b.at || (a.at === b.at && a.order < b.order)) best = i;
    }
    const [event] = events.splice(best, 1);
    if (!event || event.at > endAt) break;
    now = Math.max(now, event.at);
    event.fn();
  }

  const percentile = (list: readonly number[], q: number): number => {
    const sorted = [...list].sort((x, y) => x - y);
    return (
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    );
  };
  // Respawns teleport ships across the arena; those are not rendering glitches.
  const smooth = (list: readonly number[]): number[] =>
    list.filter((value) => value < TELEPORT_PX);
  const clientStats = client.netStats();
  const serverShip = match.world.get(shipId);
  return {
    params: { seconds, latencyMs, jitterMs, drop, codec },
    reconciliations: clientStats.reconciliations,
    mispredictions: clientStats.mispredictions,
    maxCorrectionPx: clientStats.maxCorrectionPx,
    rttMs: clientStats.rttMs,
    teleports: clientStats.teleports,
    remoteJumpP99: percentile(smooth(metrics.remoteJump), 0.99),
    remoteJumpMax: Math.max(0, ...smooth(metrics.remoteJump)),
    remoteBaselineJumpP99: percentile(smooth(metrics.remoteBaselineJump), 0.99),
    remoteBaselineJumpMax: Math.max(0, ...smooth(metrics.remoteBaselineJump)),
    ownJumpMax: Math.max(0, ...smooth(metrics.ownJump)),
    kbPerSecDown: stats.bytesDown / seconds / 1024,
    kbPerSecUp: stats.bytesUp / seconds / 1024,
    droppedDown: down.dropped,
    droppedUp: up.dropped,
    serverStarvedSteps: match.starvedSteps,
    finalAck: client.ack,
    finalSeq: client.nextSeq - 1,
    serverShip: serverShip
      ? { x: serverShip.pos.x, y: serverShip.pos.y }
      : null,
    clientShip: client.ship ? { ...client.ship.pos } : null,
  };
}
