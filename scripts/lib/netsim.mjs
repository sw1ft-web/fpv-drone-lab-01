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
  binaryCodec,
  createRng,
  integrateShip,
  jsonCodec,
} from "../../shared/src/index.js";
import { GameClient } from "../../client/src/net/gameclient.js";
import { Match } from "../../server/src/match.js";

const STEP_MS = SIM_STEP * 1000;
const TELEPORT_PX = 100;

/** A scripted pilot: turns and thrusts in changing patterns and fires now and then. */
export function pilot(seedValue) {
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
} = {}) {
  let now = 0;
  const events = [];
  let sequence = 0;
  const schedule = (fn, ms) => {
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
  const wire = codec === "binary" ? binaryCodec : jsonCodec;

  let toClient = () => {};
  const match = new Match({
    arenaId: "arena-neon",
    seed,
    ...(serverIntegrate ? { integrate: serverIntegrate } : {}),
    onSnapshot: (playerId, snapshot) => {
      if (playerId !== "me") return;
      const frame = wire.encodeSnapshot(snapshot);
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
      const payload =
        typeof frame === "object" && !(frame instanceof Uint8Array)
          ? JSON.stringify({ v: 1, ...frame })
          : frame;
      stats.bytesUp +=
        typeof payload === "string" ? payload.length : payload.byteLength;
      stats.inputMessages += 1;
      up.send(payload, (data) => {
        match.receiveInputs("me", wire.decodeInput(data).inputs);
      });
    },
  });
  toClient = (data, size) => {
    const snapshot = wire.decodeSnapshot(data);
    client.ingest(snapshot, size);
  };

  const myPilot = pilot(seed);
  const metrics = {
    frames: 0,
    remoteJump: [],
    remoteBaselineJump: [],
    ownJump: [],
  };
  let lastRemote = null;
  let lastBaseline = null;
  let lastOwn = null;
  const jump = (a, b) =>
    Math.hypot(
      ((b.x - a.x + 800 + 1600) % 1600) - 800,
      ((b.y - a.y + 450 + 900) % 900) - 450,
    );

  // Periodic processes on the virtual clock.
  const every = (periodMs, fn) => {
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
    match.receiveInputs("rival", [{ seq: rivalSeq, bits: rivalPilot() }]);
    // Render at 60 Hz right after the step (alpha = 1).
    const view = client.view(1, now);
    metrics.frames += 1;
    const remote = view.ships.find((s) => s.id === rivalId);
    if (remote) {
      if (lastRemote && lastRemote.active && remote.active)
        metrics.remoteJump.push(jump(lastRemote, remote));
      lastRemote = { x: remote.x, y: remote.y, active: remote.active };
    }
    const latest = client.buffer.latest?.entities.find((e) => e.id === rivalId);
    if (latest) {
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
      if (a.at < b.at || (a.at === b.at && a.order < b.order)) best = i;
    }
    const event = events.splice(best, 1)[0];
    if (event.at > endAt) break;
    now = Math.max(now, event.at);
    event.fn();
  }

  const percentile = (list, q) => {
    if (!list.length) return 0;
    const sorted = [...list].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  // Respawns teleport ships across the arena; those are not rendering glitches.
  const smooth = (list) => list.filter((value) => value < TELEPORT_PX);
  const clientStats = client.netStats();
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
    serverShip: match.world.get(shipId)
      ? { x: match.world.get(shipId).pos.x, y: match.world.get(shipId).pos.y }
      : null,
    clientShip: client.ship ? { ...client.ship.pos } : null,
  };
}
