import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { parseServerMessage } from "@fpv/shared/protocol";
import type { ServerMessage } from "@fpv/shared/protocol";
import { rawToText } from "../src/protocol.ts";
import { loadConfig } from "../src/config.ts";
import type { ServerConfig } from "../src/config.ts";
import { createApp } from "../src/index.ts";
import type { App } from "../src/index.ts";
import { silentLogger } from "../src/logger.ts";

export interface TestServer {
  app: App;
  config: ServerConfig;
  origin: string;
  wsUrl: string;
  logDir: string;
  stop(): Promise<void>;
}

export async function startTestServer(
  overrides: Record<string, string> = {},
): Promise<TestServer> {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-logs-"));
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: logDir,
    CLIENT_DIR: join(logDir, "no-client"),
    ...overrides,
  });
  const app = createApp(config, { logger: silentLogger });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    app,
    config,
    origin,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    logDir,
    async stop() {
      await app.close();
      await rm(logDir, { recursive: true, force: true });
    },
  };
}

export interface CloseInfo {
  code: number;
  reason: string;
}

interface Waiter {
  check(): void;
}

/** A message the test client may send: anything, because tests deliberately send garbage too. */
export type Outgoing = Record<string, unknown>;

export interface TestClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  readonly closed: CloseInfo | null;
  send(message: Outgoing): void;
  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ServerMessage>;
  /** Waits for the first message of a type and returns it with that type's exact shape. */
  waitForType<T extends ServerMessage["type"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  waitForClose(timeoutMs?: number): Promise<CloseInfo>;
}

/** Type guard factory: narrows a ServerMessage to the one with this `type`. */
const is =
  <T extends ServerMessage["type"]>(type: T) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: T }> =>
    message.type === type;

/** A tiny WebSocket test client that records every message and the close event. */
export async function connect(
  url: string,
  { open = true }: { open?: boolean } = {},
): Promise<TestClient> {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const waiters: Waiter[] = [];
  let closed: CloseInfo | null = null;

  socket.on("message", (data, isBinary) => {
    if (isBinary) return; // game traffic in the binary codec is covered by dedicated tests
    const parsed = parseServerMessage(JSON.parse(rawToText(data)));
    if (!parsed.ok)
      throw new Error(`server sent an invalid message: ${parsed.error}`);
    messages.push(parsed.value);
    for (const waiter of [...waiters]) waiter.check();
  });
  socket.on("close", (code, reason) => {
    closed = { code, reason: reason.toString() };
    for (const waiter of [...waiters]) waiter.check();
  });
  socket.on("error", () => {});

  if (open) await once(socket, "open");

  const remove = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
  };

  const client: TestClient = {
    socket,
    messages,
    get closed() {
      return closed;
    },
    send: (message) => socket.send(JSON.stringify({ v: 1, ...message })),
    waitFor(predicate, timeoutMs = 2000) {
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          remove(waiter);
          reject(
            new Error(
              `timeout waiting for message; got ${JSON.stringify(messages)}`,
            ),
          );
        }, timeoutMs);
        const waiter: Waiter = {
          check() {
            const found = messages.find(predicate);
            if (found) {
              clearTimeout(timer);
              remove(waiter);
              resolve(found);
            }
          },
        };
        waiters.push(waiter);
        waiter.check();
      });
    },
    async waitForType(type, timeoutMs) {
      const guard = is(type);
      const message = await client.waitFor(guard, timeoutMs);
      if (!guard(message)) throw new Error(`expected a ${type} message`);
      return message;
    },
    waitForClose(timeoutMs = 2000) {
      return new Promise<CloseInfo>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for close")),
          timeoutMs,
        );
        const waiter: Waiter = {
          check() {
            if (closed) {
              clearTimeout(timer);
              remove(waiter);
              resolve(closed);
            }
          },
        };
        waiters.push(waiter);
        waiter.check();
      });
    },
  };
  return client;
}
