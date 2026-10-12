import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIM_STEP,
  SNAPSHOT_FLAGS,
  STEPS_PER_TICK,
  TICK_MS,
  integrateShip,
} from "@fpv/shared";
import { GameClient } from "../src/net/gameclient.js";

const welcome = {
  shipId: 1,
  codec: "json",
  arena: { width: 1600, height: 900 },
};

function makeClient() {
  let now = 0;
  const sent = [];
  const client = new GameClient({
    welcome,
    now: () => now,
    send: (frame) => sent.push(frame),
  });
  return {
    client,
    sent,
    advance: (ms) => (now += ms),
    get now() {
      return now;
    },
  };
}

const snapshot = (tick, ack, ship, extra = []) => ({
  tick,
  ack,
  entities: [
    {
      id: 1,
      kind: "ship",
      x: ship.x,
      y: ship.y,
      vx: ship.vx ?? 0,
      vy: ship.vy ?? 0,
      angle: ship.angle ?? 0,
      hp: 100,
      score: 0,
      flags: SNAPSHOT_FLAGS.ACTIVE,
    },
    ...extra,
  ],
});

test("sends one input message per tick carrying the unacknowledged inputs", () => {
  const { client, sent } = makeClient();
  for (let i = 0; i < 2 * STEPS_PER_TICK; i += 1) client.step(4);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent[1].inputs.map((i) => i.seq),
    [1, 2, 3, 4],
  );
});

test("never sends more than 16 inputs per message", () => {
  const { client, sent } = makeClient();
  for (let i = 0; i < 100; i += 1) client.step(0);
  assert.ok(sent.every((m) => m.inputs.length <= 16));
});

test("prediction moves the ship before any server answer", () => {
  const { client } = makeClient();
  client.ingest(snapshot(1, 0, { x: 100, y: 100, angle: 0 }));
  for (let i = 0; i < 30; i += 1) client.step(4); // thrust
  const view = client.view(1);
  assert.ok(view.own.x > 100, `x=${view.own.x}`);
});

test("reconciliation replays unacknowledged inputs and leaves no error when the server agrees", () => {
  const h = makeClient();
  const { client, advance } = h;
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }));
  // The client runs 10 steps ahead...
  const predicted = {
    pos: { x: 100, y: 100 },
    vel: { x: 0, y: 0 },
    angle: 0,
    thrust: 0,
  };
  const bits = [];
  for (let i = 0; i < 10; i += 1) {
    bits.push(4);
    client.step(4);
  }
  // ...the server meanwhile has applied the first 4 of them.
  const server = {
    pos: { x: 100, y: 100 },
    vel: { x: 0, y: 0 },
    angle: 0,
    thrust: 0,
  };
  for (let i = 0; i < 4; i += 1)
    integrateShip(server, { thrust: true }, SIM_STEP, 1600, 900);
  advance(60);
  client.ingest(
    snapshot(2, 4, {
      x: server.pos.x,
      y: server.pos.y,
      vx: server.vel.x,
      vy: server.vel.y,
      angle: server.angle,
    }),
  );
  for (let i = 0; i < 10; i += 1)
    integrateShip(predicted, { thrust: true }, SIM_STEP, 1600, 900);
  assert.equal(client.pending.length, 6);
  assert.ok(Math.abs(client.ship.pos.x - predicted.pos.x) < 1e-9);
  assert.equal(client.stats.mispredictions, 0);
});

test("a server that disagrees produces a correction that fades out instead of snapping", () => {
  const h = makeClient();
  const { client, advance } = h;
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }));
  for (let i = 0; i < 4; i += 1) client.step(0);
  advance(40);
  const before = client.view(1, h.now).own.x;

  // Server says the ship is 30 px away from where we predicted it.
  client.ingest(snapshot(2, 4, { x: 130, y: 100 }));
  const justAfter = client.view(1, h.now).own.x;
  assert.ok(Math.abs(justAfter - before) < 1, "no visible jump");
  assert.equal(client.stats.mispredictions, 1);
  const later = client.view(1, h.now + 400).own.x;
  assert.ok(
    Math.abs(later - 130) < 1,
    `converged to server position, x=${later}`,
  );
});

test("a teleport (respawn) snaps instead of smoothing", () => {
  const h = makeClient();
  const { client, advance } = h;
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }));
  advance(33);
  client.ingest(snapshot(2, 0, { x: 1200, y: 700 }));
  assert.equal(client.stats.teleports, 1);
  assert.equal(Math.round(client.view(1, h.now).own.x), 1200);
});

test("predicted bullets are dropped once the server has shown and removed them", () => {
  const h = makeClient();
  const { client, advance } = h;
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }));
  client.step(16); // fire at seq 1
  assert.equal(client.bullets.length, 1);
  const bullet = (tick) => ({
    id: 9,
    kind: "bullet",
    x: 150,
    y: 100,
    vx: 640,
    vy: 0,
    angle: 0,
    ownerId: 1,
    fireSeq: 1,
    tick,
  });
  advance(33);
  client.ingest(snapshot(2, 1, { x: 100, y: 100 }, [bullet(2)]));
  assert.equal(client.bullets.length, 1, "kept while the server has it");
  advance(33);
  client.ingest(snapshot(3, 2, { x: 100, y: 100 }));
  assert.equal(client.bullets.length, 0, "server removed it");
});

test("a shot the server never confirmed is withdrawn after the ack passes it", () => {
  const h = makeClient();
  const { client, advance } = h;
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }));
  client.step(16);
  advance(33);
  client.ingest(snapshot(2, 1, { x: 100, y: 100 }));
  assert.equal(client.bullets.length, 0);
});

test("emits score and explosion events derived from snapshots", () => {
  const h = makeClient();
  const { client, advance } = h;
  const events = [];
  for (const type of ["scoreChanged", "exploded", "hit"])
    client.addEventListener(type, (e) => events.push([type, e.detail]));
  const asteroid = {
    id: 5,
    kind: "asteroid",
    x: 1,
    y: 1,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 30,
    homing: 0,
  };
  client.ingest(snapshot(1, 0, { x: 100, y: 100 }, [asteroid]));
  advance(33);
  const next = snapshot(2, 0, { x: 100, y: 100 });
  next.entities[0].score = 10;
  next.entities[0].hp = 75;
  client.ingest(next);
  const types = events.map(([type]) => type).sort();
  assert.deepEqual(types, ["exploded", "hit", "scoreChanged"]);
});

test("TICK_MS is the snapshot spacing used for the clock estimate", () => {
  assert.ok(Math.abs(TICK_MS - 1000 / 30) < 1e-9);
});
