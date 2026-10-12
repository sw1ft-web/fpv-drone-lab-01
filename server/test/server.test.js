import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CLOSE } from "../src/protocol.js";
import { connect, startTestServer } from "./helpers.js";

const json = (response) => response.json();
const post = (url, body, headers = { "content-type": "application/json" }) =>
  fetch(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("HTTP API", () => {
  let server;
  before(async () => {
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
  after(() => server.stop());

  test("GET /health", async () => {
    const response = await fetch(`${server.origin}/health`);
    assert.equal(response.status, 200);
    assert.equal((await json(response)).status, "ok");
  });

  test("GET /api/rooms lists the seeded rooms", async () => {
    const body = await json(await fetch(`${server.origin}/api/rooms`));
    assert.deepEqual(
      body.rooms.map((room) => room.id),
      ["kyiv-alpha", "training-01", "night-run"],
    );
    assert.equal(body.rooms[0].players, 0);
  });

  test("POST /api/rooms validates input and creates a room", async () => {
    const ok = await post(`${server.origin}/api/rooms`, {
      name: "Dogfight",
      maxPlayers: 4,
    });
    assert.equal(ok.status, 201);
    assert.equal((await json(ok)).id, "dogfight");

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
  let server;
  before(async () => {
    server = await startTestServer({
      JOIN_TIMEOUT_MS: "200",
      MAX_PAYLOAD_BYTES: "512",
      RATE_CAPACITY: "6",
      RATE_REFILL_PER_SEC: "1",
    });
  });
  after(() => server.stop());

  test("two clients join the same room, see each other and chat", async () => {
    const a = await connect(server.wsUrl);
    const b = await connect(server.wsUrl);
    a.send({ type: "join", roomId: "kyiv-alpha", name: "Ann" });
    const welcomeA = await a.waitFor((m) => m.type === "welcome");
    assert.equal(welcomeA.room.id, "kyiv-alpha");

    b.send({ type: "join", roomId: "kyiv-alpha", name: "Bob" });
    const rosterA = await a.waitFor(
      (m) => m.type === "roster" && m.roster.length === 2,
    );
    assert.deepEqual(rosterA.roster.map((p) => p.name).sort(), ["Ann", "Bob"]);

    a.send({ type: "chat", text: "hello Bob" });
    const chatB = await b.waitFor((m) => m.type === "chat");
    assert.equal(chatB.from, "Ann");
    assert.equal(chatB.text, "hello Bob");

    b.socket.close();
    const rosterAfter = await a.waitFor(
      (m) => m.type === "roster" && m.roster.length === 1,
    );
    assert.equal(rosterAfter.roster[0].name, "Ann");
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
    await client.waitFor((m) => m.type === "welcome");
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
    await first.waitFor((m) => m.type === "welcome");
    const second = await connect(server.wsUrl);
    second.send({ type: "join", roomId: "duo", name: "Two" });
    assert.equal((await second.waitForClose()).code, CLOSE.ROOM_UNAVAILABLE);
    first.socket.close();
  });
});

describe("match logs and replays", () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.stop());

  test("a finished room session can be streamed back as NDJSON", async () => {
    const client = await connect(server.wsUrl);
    client.send({ type: "join", roomId: "night-run", name: "Ann" });
    await client.waitFor((m) => m.type === "welcome");
    client.send({ type: "chat", text: "for the record" });
    await client.waitFor((m) => m.type === "chat");
    client.socket.close();
    await client.waitForClose();

    let replays = [];
    for (let attempt = 0; attempt < 40 && replays.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      replays = (await json(await fetch(`${server.origin}/api/replays`)))
        .replays;
    }
    assert.equal(replays.length, 1);

    const response = await fetch(
      `${server.origin}/api/replays/${replays[0].id}`,
    );
    assert.equal(
      response.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
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
