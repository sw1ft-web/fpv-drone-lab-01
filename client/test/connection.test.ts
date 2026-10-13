import assert from "node:assert/strict";
import { once } from "node:events";
import { afterAll, beforeAll, test } from "vitest";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import type { Bus } from "@fpv/shared";
import { Connection, backoffDelay } from "../src/net/connection.ts";
import type { ConnectionEvents } from "../src/net/connection.ts";

/** What the test server records of each client message. */
const Received = z.object({
  v: z.number(),
  type: z.string(),
  text: z.string().optional(),
});
type Received = z.output<typeof Received>;

/** Resolves with the payload of the next `name` lifecycle event of a connection. */
const nextEvent = <K extends keyof ConnectionEvents>(
  bus: Bus<ConnectionEvents>,
  name: K,
): Promise<ConnectionEvents[K]> =>
  new Promise((resolve) => {
    const off = bus.on(name, (payload) => {
      off();
      resolve(payload);
    });
  });

/** A server-to-client chat frame that passes the shared schema. */
const chatFrame = (text: string): string =>
  JSON.stringify({ v: 1, type: "chat", from: "Bob", text, t: 0 });

/** Text of a frame from `ws`, which may hand over one buffer, several or an ArrayBuffer. */
const rawText = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : data.toString("utf8");

let wss: WebSocketServer;
let url: string;
const received: Received[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const address = wss.address();
  assert.ok(typeof address === "object" && address !== null);
  url = `ws://127.0.0.1:${address.port}`;
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) received.push(Received.parse(JSON.parse(rawText(data))));
    });
  });
});

afterAll(() => {
  for (const client of wss.clients) client.terminate();
  return new Promise<void>((resolve) => wss.close(() => resolve()));
});

/** The server-side socket number `index`; fails the test if it has not connected. */
const serverSocket = (index: number): WebSocket => {
  const socket = sockets[index];
  assert.ok(socket, `no server socket #${index}`);
  return socket;
};
const lastSocket = (): WebSocket => serverSocket(sockets.length - 1);

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
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
  const seen: string[] = [];
  connection.on("chat", (message) => seen.push(message.text));
  const opened = nextEvent(connection.lifecycle, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  const serverSide = serverSocket(before);
  serverSide.send(chatFrame("hello"));
  serverSide.send(JSON.stringify({ v: 1, type: "unheard", text: "ignored" }));
  serverSide.send("not json");
  await waitUntil(() => seen.length === 1 && connection.invalidMessages === 2);
  assert.deepEqual(seen, ["hello"]);
  connection.close();
});

test("reconnects with backoff after an abnormal close and re-sends the join", async () => {
  received.length = 0;
  const connection = new Connection({ url, baseMs: 10, random: () => 1 });
  connection.setSession({ type: "join", roomId: "r", name: "Ann" });
  const reconnects: ConnectionEvents["reconnecting"][] = [];
  connection.lifecycle.on("reconnecting", (detail) => reconnects.push(detail));

  connection.connect();
  await waitUntil(() => received.length === 1);
  lastSocket().terminate(); // abnormal close (1006)

  await waitUntil(() => received.length === 2);
  assert.deepEqual(
    received.map((message) => message.type),
    ["join", "join"],
  );
  const [first] = reconnects;
  assert.ok(first);
  assert.equal(first.attempt, 1);
  assert.equal(first.delayMs, 10);
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
  const opened = nextEvent(connection.lifecycle, "open");
  connection.connect();
  await opened;
  const closed = nextEvent(connection.lifecycle, "close");
  serverSocket(before).close(4003, "rate limit exceeded");
  const event = await closed;
  assert.equal(event.code, 4003);
  assert.equal(event.willReconnect, false);
  assert.equal(connection.state, "closed");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sockets.length, before + 1);
});

test("delivers binary frames to onBinary and counts bytes", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const frames: [Uint8Array, number][] = [];
  connection.onBinary((bytes, size) => frames.push([bytes, size]));
  const opened = nextEvent(connection.lifecycle, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  lastSocket().send(new Uint8Array([2, 1, 0, 0]));
  await waitUntil(() => frames.length === 1);
  const [frame] = frames;
  assert.ok(frame);
  assert.deepEqual([...frame[0]], [2, 1, 0, 0]);
  assert.equal(frame[1], 4);
  assert.equal(connection.bytesIn, 4);
  connection.close();
});

test("send() accepts ready-made binary frames", async () => {
  received.length = 0;
  const binary: number[][] = [];
  const before = sockets.length;
  const connection = new Connection({ url, baseMs: 10 });
  const opened = nextEvent(connection.lifecycle, "open");
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  lastSocket().on("message", (data, isBinary) => {
    if (isBinary && Buffer.isBuffer(data)) binary.push([...data]);
  });
  connection.send(new Uint8Array([1, 1, 2, 0]));
  await waitUntil(() => binary.length === 1);
  assert.deepEqual(binary[0], [1, 1, 2, 0]);
  connection.close();
});

test("setNetwork delays delivery in both directions", async () => {
  const connection = new Connection({ url, baseMs: 10 });
  const seen: number[] = [];
  connection.on("chat", () => seen.push(performance.now()));
  const opened = nextEvent(connection.lifecycle, "open");
  const before = sockets.length;
  connection.connect();
  await opened;
  await waitUntil(() => sockets.length > before);
  connection.setNetwork({ latencyMs: 120 });
  const start = performance.now();
  lastSocket().send(chatFrame("late"));
  await waitUntil(() => seen.length === 1);
  const arrival = seen[0] ?? 0;
  assert.ok(arrival - start >= 100, `arrived after ${arrival - start} ms`);
  assert.deepEqual(connection.network, {
    latencyMs: 120,
    jitterMs: 0,
    drop: 0,
  });
  connection.close();
});
