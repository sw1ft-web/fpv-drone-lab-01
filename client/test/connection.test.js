import assert from "node:assert/strict";
import { once } from "node:events";

// Connection has an `on()` method, so events.once() would mistake it for an EventEmitter.
const nextEvent = (target, name) =>
  new Promise((resolve) =>
    target.addEventListener(name, (event) => resolve([event]), { once: true }),
  );
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { Connection, backoffDelay } from "../src/net/connection.js";

let wss;
let url;
const received = [];
const sockets = [];

before(async () => {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  url = `ws://127.0.0.1:${wss.address().port}`;
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) received.push(JSON.parse(data.toString()));
    });
  });
});

after(() => {
  for (const client of wss.clients) client.terminate();
  return new Promise((resolve) => wss.close(resolve));
});

const waitUntil = async (predicate, timeoutMs = 2000) => {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("queues messages while connecting and flushes them in order after the session join", async () => {
  received.length = 0;
  const connection = new Connection({ url, baseMs: 10 });
  connection.setSession({ type: "join", roomId: "r", name: "Ann" });
  connection.send({ type: "chat", text: "one" });
  connection.send({ type: "chat", text: "two" });
  connection.connect();

  await waitUntil(() => received.length === 3);
  assert.deepEqual(
    received.map(
      (message) => message.type + (message.text ? `:${message.text}` : ""),
    ),
    ["join", "chat:one", "chat:two"],
  );
  assert.ok(received.every((message) => message.v === 1));
  connection.close();
});

test("dispatches server messages by type", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const seen = [];
  connection.on("chat", (message) => seen.push(message.text));
  const opened = nextEvent(connection, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  const serverSide = sockets[before];
  serverSide.send(JSON.stringify({ v: 1, type: "chat", text: "hello" }));
  serverSide.send(JSON.stringify({ v: 1, type: "unheard", text: "ignored" }));
  serverSide.send("not json");
  await waitUntil(() => seen.length === 1);
  assert.deepEqual(seen, ["hello"]);
  connection.close();
});

test("reconnects with backoff after an abnormal close and re-sends the join", async () => {
  received.length = 0;
  const connection = new Connection({ url, baseMs: 10, random: () => 1 });
  connection.setSession({ type: "join", roomId: "r", name: "Ann" });
  const reconnects = [];
  connection.addEventListener("reconnecting", (event) =>
    reconnects.push(event.detail),
  );

  connection.connect();
  await waitUntil(() => received.length === 1);
  sockets.at(-1).terminate(); // abnormal close (1006)

  await waitUntil(() => received.length === 2);
  assert.deepEqual(
    received.map((message) => message.type),
    ["join", "join"],
  );
  assert.equal(reconnects[0].attempt, 1);
  assert.equal(reconnects[0].delayMs, 10);
  connection.close();
});

test("backoff grows exponentially, is jittered and capped", () => {
  const options = { baseMs: 100, maxMs: 500 };
  const top = [0, 1, 2, 3, 4, 5].map((attempt) =>
    backoffDelay(attempt, { ...options, random: () => 1 }),
  );
  assert.deepEqual(top, [100, 200, 400, 500, 500, 500]);
  const low = [0, 1, 2].map((attempt) =>
    backoffDelay(attempt, { ...options, random: () => 0 }),
  );
  assert.deepEqual(low, [50, 100, 200]);
});

test("does not reconnect after a fatal close code", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const before = sockets.length;
  const opened = nextEvent(connection, "open");
  connection.connect();
  await opened;
  const closed = nextEvent(connection, "close");
  sockets[before].close(4003, "rate limit exceeded");
  const [event] = await closed;
  assert.equal(event.detail.code, 4003);
  assert.equal(event.detail.willReconnect, false);
  assert.equal(connection.state, "closed");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sockets.length, before + 1);
});

test("delivers binary frames to onBinary and counts bytes", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const frames = [];
  connection.onBinary((bytes, size) => frames.push([bytes, size]));
  const opened = nextEvent(connection, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  sockets.at(-1).send(new Uint8Array([2, 1, 0, 0]));
  await waitUntil(() => frames.length === 1);
  assert.deepEqual([...frames[0][0]], [2, 1, 0, 0]);
  assert.equal(frames[0][1], 4);
  assert.equal(connection.bytesIn, 4);
  connection.close();
});

test("send() accepts ready-made binary frames", async () => {
  received.length = 0;
  const binary = [];
  const before = sockets.length;
  const connection = new Connection({ url, baseMs: 10 });
  const opened = nextEvent(connection, "open");
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  sockets.at(-1).on("message", (data, isBinary) => {
    if (isBinary) binary.push([...data]);
  });
  connection.send(new Uint8Array([1, 1, 2, 0]));
  await waitUntil(() => binary.length === 1);
  assert.deepEqual(binary[0], [1, 1, 2, 0]);
  connection.close();
});

test("setNetwork delays delivery in both directions", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const seen = [];
  connection.on("chat", () => seen.push(performance.now()));
  const opened = nextEvent(connection, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  connection.setNetwork({ latencyMs: 120 });
  const start = performance.now();
  sockets.at(-1).send(JSON.stringify({ v: 1, type: "chat", text: "late" }));
  await waitUntil(() => seen.length === 1);
  assert.ok(seen[0] - start >= 100, `arrived after ${seen[0] - start} ms`);
  assert.deepEqual(connection.network, {
    latencyMs: 120,
    jitterMs: 0,
    drop: 0,
  });
  connection.close();
});
