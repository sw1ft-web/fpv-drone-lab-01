import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { CLOSE } from "../src/protocol.ts";
import { connect, startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";
import type { ServerMessage } from "@fpv/shared/protocol";

/** Response bodies are `unknown` until a schema says otherwise. */
const json = async <S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> => schema.parse(await response.json());

const HealthBody = z.object({ status: z.string() });
const RoomsBody = z.object({
  rooms: z.array(z.object({ id: z.string(), players: z.number() })),
});
const CreatedBody = z.object({ id: z.string() });
const ReplaysBody = z.object({
  replays: z.array(z.object({ id: z.string() })),
});
const ReplayEvent = z.object({ type: z.string() });

const rosterNames = (message: ServerMessage): string[] =>
  message.type === "roster" ? message.roster.map((p) => p.name).sort() : [];

const post = (
  url: string,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) =>
  fetch(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("HTTP API", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ MAX_BODY_BYTES: "256" });
    await mkdir(join(server.config.CLIENT_DIR, "assets"), { recursive: true });
    await writeFile(
      join(server.config.CLIENT_DIR, "index.html"),
      "<h1>fpv</h1>",
    );
    await writeFile(
      join(server.config.CLIENT_DIR, "assets", "app.js"),
      "export {}",
    );
    await writeFile(join(server.config.CLIENT_DIR, "assets", "x.wav"), "RIFF");
  });
  afterAll(() => server.stop());

  test("GET /health", async () => {
    const response = await fetch(`${server.origin}/health`);
    assert.equal(response.status, 200);
    assert.equal((await json(response, HealthBody)).status, "ok");
  });

  test("GET /api/rooms lists the seeded rooms", async () => {
    const body = await json(
      await fetch(`${server.origin}/api/rooms`),
      RoomsBody,
    );
    assert.deepEqual(
      body.rooms.map((room) => room.id),
      ["kyiv-alpha", "training-01", "night-run"],
    );
    assert.equal(body.rooms[0]?.players, 0);
  });

  test("POST /api/rooms validates input and creates a room", async () => {
    const ok = await post(`${server.origin}/api/rooms`, {
      name: "Dogfight",
      maxPlayers: 4,
    });
    assert.equal(ok.status, 201);
    assert.equal((await json(ok, CreatedBody)).id, "dogfight");

    assert.equal(
      (await post(`${server.origin}/api/rooms`, { name: "Dogfight" })).status,
      409,
    );
    assert.equal(
      (await post(`${server.origin}/api/rooms`, { name: "" })).status,
      400,
    );
    assert.equal(
      (await post(`${server.origin}/api/rooms`, "{nope")).status,
      400,
    );
    assert.equal(
      (
        await post(`${server.origin}/api/rooms`, "{}", {
          "content-type": "text/plain",
        })
      ).status,
      415,
    );
  });

  test("POST /api/rooms caps the body size", async () => {
    const response = await post(`${server.origin}/api/rooms`, {
      name: "x".repeat(1000),
    });
    assert.equal(response.status, 413);
  });

  test("static files: MIME types, 404 and path traversal guard", async () => {
    const index = await fetch(`${server.origin}/`);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await index.text(), "<h1>fpv</h1>");

    const script = await fetch(`${server.origin}/assets/app.js`);
    assert.equal(
      script.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.equal(
      (await fetch(`${server.origin}/assets/x.wav`)).headers.get(
        "content-type",
      ),
      "audio/wav",
    );

    assert.equal((await fetch(`${server.origin}/missing.png`)).status, 404);

    // fetch() normalises "/../", so send raw requests with encoded traversal.
    for (const path of [
      "/%2e%2e/%2e%2e/package.json",
      "/..%2f..%2fpackage.json",
      "/%00",
    ]) {
      const response = await fetch(`${server.origin}${path}`);
      assert.ok(
        [403, 404].includes(response.status),
        `${path} -> ${response.status}`,
      );
      assert.notEqual(response.status, 200);
    }
  });

  test("unknown API routes return JSON 404", async () => {
    const response = await fetch(`${server.origin}/api/nope`);
    assert.equal(response.status, 404);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
  });

  test("debug route /api/slow blocks the event loop only on request", async () => {
    const started = performance.now();
    const response = await fetch(`${server.origin}/api/slow?block=120`);
    assert.equal(response.status, 200);
    assert.ok(performance.now() - started >= 100);
  });
});

describe("WebSocket protocol", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({
      JOIN_TIMEOUT_MS: "200",
      MAX_PAYLOAD_BYTES: "512",
      RATE_CAPACITY: "6",
      RATE_REFILL_PER_SEC: "1",
    });
  });
  afterAll(() => server.stop());

  test("two clients join the same room, see each other and chat", async () => {
    const a = await connect(server.wsUrl);
    const b = await connect(server.wsUrl);
    a.send({ type: "join", roomId: "kyiv-alpha", name: "Ann" });
    const welcomeA = await a.waitForType("welcome");
    assert.equal(welcomeA.room.id, "kyiv-alpha");

    b.send({ type: "join", roomId: "kyiv-alpha", name: "Bob" });
    const rosterA = await a.waitFor(
      (m) => m.type === "roster" && m.roster.length === 2,
    );
    assert.equal(rosterA.type === "roster" && rosterA.roster.length, 2);
    assert.deepEqual(rosterNames(rosterA), ["Ann", "Bob"]);

    a.send({ type: "chat", text: "hello Bob" });
    const chatB = await b.waitForType("chat");
    assert.equal(chatB.from, "Ann");
    assert.equal(chatB.text, "hello Bob");

    b.socket.close();
    const rosterAfter = await a.waitFor(
      (m) => m.type === "roster" && m.roster.length === 1,
    );
    assert.deepEqual(rosterNames(rosterAfter), ["Ann"]);
    a.socket.close();
  });

  test("closes with JOIN_TIMEOUT when no join arrives", async () => {
    const client = await connect(server.wsUrl);
    const closed = await client.waitForClose();
    assert.equal(closed.code, CLOSE.JOIN_TIMEOUT);
  });

  test("closes with BAD_MESSAGE on malformed JSON and with UNKNOWN_TYPE on unknown types", async () => {
    const bad = await connect(server.wsUrl);
    bad.socket.send("{not json");
    assert.equal((await bad.waitForClose()).code, CLOSE.BAD_MESSAGE);

    const unknown = await connect(server.wsUrl);
    unknown.send({ type: "teleport" });
    assert.equal((await unknown.waitForClose()).code, CLOSE.UNKNOWN_TYPE);
  });

  test("oversized frames are closed with 1009", async () => {
    const client = await connect(server.wsUrl);
    client.socket.send("x".repeat(2048));
    assert.equal((await client.waitForClose()).code, CLOSE.TOO_BIG);
  });

  test("joining an unknown room is refused", async () => {
    const client = await connect(server.wsUrl);
    client.send({ type: "join", roomId: "nope", name: "Ann" });
    assert.equal((await client.waitForClose()).code, CLOSE.ROOM_UNAVAILABLE);
  });

  test("a flooding client is closed by the token bucket", async () => {
    const client = await connect(server.wsUrl);
    client.send({ type: "join", roomId: "training-01", name: "Flood" });
    await client.waitForType("welcome");
    for (let i = 0; i < 30; i += 1)
      client.send({ type: "chat", text: `spam ${i}` });
    assert.equal((await client.waitForClose()).code, CLOSE.RATE_LIMIT);
  });

  test("a full room refuses new players", async () => {
    const created = await post(`${server.origin}/api/rooms`, {
      name: "Duo",
      maxPlayers: 1,
    });
    assert.equal(created.status, 201);
    const first = await connect(server.wsUrl);
    first.send({ type: "join", roomId: "duo", name: "One" });
    await first.waitForType("welcome");
    const second = await connect(server.wsUrl);
    second.send({ type: "join", roomId: "duo", name: "Two" });
    assert.equal((await second.waitForClose()).code, CLOSE.ROOM_UNAVAILABLE);
    first.socket.close();
  });
});

describe("match logs and replays", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.stop());

  test("a finished room session can be streamed back as NDJSON", async () => {
    const client = await connect(server.wsUrl);
    client.send({ type: "join", roomId: "night-run", name: "Ann" });
    await client.waitForType("welcome");
    client.send({ type: "chat", text: "for the record" });
    await client.waitForType("chat");
    client.socket.close();
    await client.waitForClose();

    let replays: { id: string }[] = [];
    for (let attempt = 0; attempt < 40 && replays.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      replays = (
        await json(await fetch(`${server.origin}/api/replays`), ReplaysBody)
      ).replays;
    }
    assert.equal(replays.length, 1);

    const first = replays[0];
    assert.ok(first);
    const response = await fetch(`${server.origin}/api/replays/${first.id}`);
    assert.equal(
      response.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => ReplayEvent.parse(JSON.parse(line)));
    assert.deepEqual(
      events.map((event) => event.type),
      ["join", "chat", "leave"],
    );

    assert.equal(
      (await fetch(`${server.origin}/api/replays/..%2fpackage`)).status,
      400,
    );
    assert.equal(
      (await fetch(`${server.origin}/api/replays/missing-1`)).status,
      404,
    );
  });
});

describe("heartbeat", () => {
  test("a client that never answers pings is terminated after two missed pongs", async () => {
    const server = await startTestServer({ HEARTBEAT_MS: "50" });
    try {
      const socket = new WebSocket(server.wsUrl, { autoPong: false });
      await once(socket, "open");
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("not terminated in time")), 2000),
      );
      await Promise.race([once(socket, "close"), timeout]);
      assert.equal(server.app.stats.heartbeatTerminations, 1);
    } finally {
      await server.stop();
    }
  });

  test("a client that answers pings stays connected", async () => {
    const server = await startTestServer({ HEARTBEAT_MS: "50" });
    try {
      const socket = new WebSocket(server.wsUrl);
      await once(socket, "open");
      await new Promise((done) => setTimeout(done, 400));
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.equal(server.app.stats.heartbeatTerminations, 0);
      socket.close();
    } finally {
      await server.stop();
    }
  });
});
