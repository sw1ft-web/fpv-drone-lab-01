import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

const silentLogger = { info() {}, warn() {}, error() {} };

export async function startTestServer(overrides = {}) {
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

/** A tiny WebSocket test client that records every message and the close event. */
export async function connect(url, { open = true } = {}) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closed = null;

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) waiter.check();
  });
  socket.on("close", (code, reason) => {
    closed = { code, reason: reason.toString() };
    for (const waiter of [...waiters]) waiter.check();
  });
  socket.on("error", () => {});

  if (open) await once(socket, "open");

  const client = {
    socket,
    messages,
    get closed() {
      return closed;
    },
    send: (message) => socket.send(JSON.stringify({ v: 0, ...message })),
    waitFor(predicate, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(
            new Error(
              `timeout waiting for message; got ${JSON.stringify(messages)}`,
            ),
          );
        }, timeoutMs);
        const waiter = {
          check() {
            const found = messages.find(predicate);
            if (found) {
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(waiter), 1);
              resolve(found);
            }
          },
        };
        waiters.push(waiter);
        waiter.check();
      });
    },
    waitForClose(timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for close")),
          timeoutMs,
        );
        const waiter = {
          check() {
            if (closed) {
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(waiter), 1);
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
