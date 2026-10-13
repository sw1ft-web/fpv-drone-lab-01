import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, test } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { createRequestHandler } from "../src/http.ts";
import { clientIp, originAllowed } from "../src/ws.ts";
import { RoomManager } from "../src/rooms.ts";
import { createStats } from "../src/ws.ts";
import { silentLogger } from "../src/logger.ts";
import { connect, startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

const Health = z.object({
  status: z.string(),
  version: z.string(),
  sha: z.string(),
  startedAt: z.string(),
});

/** Opens a raw socket and reports how the handshake ended. */
async function handshake(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number | "open" }> {
  const socket = new WebSocket(url, { headers });
  socket.on("error", () => {});
  return new Promise((resolve) => {
    socket.once("open", () => {
      socket.close();
      resolve({ status: "open" });
    });
    socket.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
  });
}

describe("origin policy (pure)", () => {
  test("no Origin header (non-browser client) is allowed", () => {
    assert.equal(originAllowed(undefined, "game.example", []), true);
  });
  test("same-origin is allowed when the list is empty, other sites are not", () => {
    assert.equal(
      originAllowed("https://game.example", "game.example", []),
      true,
    );
    assert.equal(
      originAllowed("https://evil.example", "game.example", []),
      false,
    );
    assert.equal(originAllowed("not a url", "game.example", []), false);
  });
  test("an explicit list replaces the same-origin rule", () => {
    const list = ["https://fpv.example"];
    assert.equal(originAllowed("https://fpv.example", "other", list), true);
    assert.equal(
      originAllowed("https://game.example", "game.example", list),
      false,
    );
  });
  test("X-Forwarded-For is honoured only when the proxy is trusted", () => {
    const request = {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    } as unknown as Parameters<typeof clientIp>[0];
    assert.equal(clientIp(request, true), "9.9.9.9");
    assert.equal(clientIp(request, false), "10.0.0.1");
  });
});

describe("operational endpoints", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ GIT_SHA: "abc1234" });
  });
  afterAll(() => server.stop());

  test("/health is liveness and carries the version stamp", async () => {
    const body = Health.parse(
      await (await fetch(`${server.origin}/health`)).json(),
    );
    assert.equal(body.status, "ok");
    assert.equal(body.sha, "abc1234");
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  });

  test("/ready is 200 while serving", async () => {
    const response = await fetch(`${server.origin}/ready`);
    assert.equal(response.status, 200);
  });

  test("/ready is 503 once the server stops being ready", async () => {
    const ready = { value: true };
    const http = createServer(
      createRequestHandler({
        config: loadConfig({ PORT: "0" }),
        roomManager: new RoomManager({ maxRooms: 1, maxPlayersPerRoom: 1 }),
        stats: { ...createStats() },
        logger: silentLogger,
        isReady: () => ready.value,
      }),
    );
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    ready.value = false;
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    http.close();
  });

  test("/metrics exposes game, runtime and rejection metrics in Prometheus format", async () => {
    const client = await connect(server.wsUrl);
    client.send({ type: "join", roomId: "kyiv-alpha", name: "Metr" });
    await client.waitForType("welcome");
    const text = await (await fetch(`${server.origin}/metrics`)).text();
    for (const name of [
      "fpv_players 1",
      "fpv_rooms 3",
      "fpv_tick_duration_p99_seconds",
      "fpv_event_loop_utilization_ratio",
      "fpv_bytes_out_total",
      "fpv_build_info{",
      "fpv_process_resident_memory_bytes",
    ])
      assert.ok(text.includes(name), `missing ${name}`);
    client.socket.close();
  });

  test("a garbage frame is counted in fpv_rejected_total by reason", async () => {
    const client = await connect(server.wsUrl);
    client.socket.send("this is not json");
    await client.waitForClose();
    const text = await (await fetch(`${server.origin}/metrics`)).text();
    assert.match(text, /fpv_rejected_total\{reason="bad_message"\} [1-9]/);
  });
});

describe("hardening", () => {
  test("a foreign Origin is refused with 403, the configured one is accepted", async () => {
    const server = await startTestServer({
      ALLOWED_ORIGINS: "https://fpv.example",
    });
    try {
      assert.deepEqual(
        await handshake(server.wsUrl, { Origin: "https://evil.example" }),
        { status: 403 },
      );
      assert.deepEqual(
        await handshake(server.wsUrl, { Origin: "https://fpv.example" }),
        { status: "open" },
      );
      assert.deepEqual(await handshake(server.wsUrl), { status: "open" });
      const text = await (await fetch(`${server.origin}/metrics`)).text();
      assert.match(text, /fpv_rejected_total\{reason="origin"\} 1/);
    } finally {
      await server.stop();
    }
  });

  test("by default only the page's own origin may connect", async () => {
    const server = await startTestServer();
    try {
      const host = new URL(server.origin).host;
      assert.deepEqual(
        await handshake(server.wsUrl, { Origin: `http://${host}` }),
        { status: "open" },
      );
      assert.deepEqual(
        await handshake(server.wsUrl, { Origin: "http://evil.example" }),
        { status: 403 },
      );
    } finally {
      await server.stop();
    }
  });

  test("the per-IP connection cap answers 429 and frees up when sockets close", async () => {
    const server = await startTestServer({ MAX_CONNECTIONS_PER_IP: "2" });
    try {
      const a = await connect(server.wsUrl);
      const b = await connect(server.wsUrl);
      assert.deepEqual(await handshake(server.wsUrl), { status: 429 });
      a.socket.close();
      await a.waitForClose();
      await new Promise((done) => setTimeout(done, 50));
      assert.deepEqual(await handshake(server.wsUrl), { status: "open" });
      b.socket.close();
    } finally {
      await server.stop();
    }
  });

  test("/metrics can be protected with a bearer token", async () => {
    const server = await startTestServer({ METRICS_TOKEN: "s3cret" });
    try {
      assert.equal((await fetch(`${server.origin}/metrics`)).status, 401);
      const ok = await fetch(`${server.origin}/metrics`, {
        headers: { authorization: "Bearer s3cret" },
      });
      assert.equal(ok.status, 200);
    } finally {
      await server.stop();
    }
  });
});
