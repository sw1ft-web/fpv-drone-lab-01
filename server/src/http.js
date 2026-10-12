import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { RoomError } from "./rooms.js";
import { serveStatic } from "./static.js";

const REPLAY_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** Reads a JSON body, refusing to buffer more than `limit` bytes. */
async function readJsonBody(req, limit) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "request body too large");
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limit) {
      req.destroy();
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/**
 * Builds the request listener for `http.createServer`.
 * Routes: /health, /api/stats, /api/rooms (GET, POST), /api/replays[/:id],
 * debug routes (when enabled) and the built client as static files.
 */
export function createRequestHandler({
  config,
  roomManager,
  stats,
  logger = console,
}) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const startedAt = Date.now();

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        rooms: roomManager.size,
        players: roomManager.playerCount,
      });
    }

    if (pathname === "/api/stats") {
      const memory = process.memoryUsage();
      return sendJson(res, 200, {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
        eventLoopDelayMaxMs: loopDelay.max / 1e6,
        rooms: roomManager.size,
        players: roomManager.playerCount,
        ...stats,
      });
    }

    if (pathname === "/api/rooms") {
      if (method === "GET") {
        return sendJson(res, 200, {
          rooms: roomManager.list(),
          updatedAt: new Date().toISOString(),
        });
      }
      if (method === "POST") {
        const body = await readJsonBody(req, config.MAX_BODY_BYTES);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new HttpError(400, "body must be a JSON object");
        }
        try {
          const room = roomManager.create({
            name: body.name,
            arenaId: body.arenaId ?? "arena-neon",
            maxPlayers: body.maxPlayers,
          });
          return sendJson(res, 201, room.toJSON());
        } catch (error) {
          if (error instanceof RoomError) {
            const status =
              error.code === "exists"
                ? 409
                : error.code === "limit"
                  ? 429
                  : 400;
            throw new HttpError(status, error.message);
          }
          throw error;
        }
      }
      res.setHeader("Allow", "GET, POST");
      throw new HttpError(405, "method not allowed");
    }

    if (pathname === "/api/replays" && method === "GET") {
      const files = await readdir(config.LOG_DIR).catch(() => []);
      const replays = [];
      for (const name of files.filter((file) => file.endsWith(".ndjson"))) {
        const info = await stat(join(config.LOG_DIR, name));
        replays.push({
          id: name.slice(0, -".ndjson".length),
          bytes: info.size,
        });
      }
      return sendJson(res, 200, { replays });
    }

    const replayMatch = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replayMatch && method === "GET") {
      const id = decodeURIComponent(replayMatch[1]);
      if (!REPLAY_ID.test(id)) throw new HttpError(400, "invalid replay id");
      const file = resolve(config.LOG_DIR, `${id}.ndjson`);
      if (!file.startsWith(resolve(config.LOG_DIR) + sep))
        throw new HttpError(400, "invalid replay id");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "replay not found");

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      if (config.DEBUG_ROUTES && url.searchParams.get("buffered") === "1") {
        // Deliberately naive variant for the backpressure experiment: whole file in memory.
        const { readFile } = await import("node:fs/promises");
        res.end(await readFile(file));
        return;
      }
      // pipeline() pauses the file stream whenever the socket's buffer is full.
      await pipeline(createReadStream(file), res).catch((error) => {
        if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
      });
      return;
    }

    if (config.DEBUG_ROUTES && pathname === "/api/slow") {
      const block = Number(url.searchParams.get("block") ?? 0);
      if (block > 0) {
        // Deliberate synchronous block: nothing else runs on this thread meanwhile.
        const until = performance.now() + Math.min(block, 5000);
        while (performance.now() < until);
        return sendJson(res, 200, {
          ok: true,
          blockedMs: Math.min(block, 5000),
        });
      }
      const delay = Math.min(
        5000,
        Math.max(0, Number(url.searchParams.get("delay")) || 1800),
      );
      await new Promise((done) => setTimeout(done, delay));
      if (!res.writableEnded) sendJson(res, 200, { ok: true, delay });
      return;
    }

    if (config.DEBUG_ROUTES && pathname === "/api/bad-json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"rooms": [ { "id": "broken", ] }');
      return;
    }

    if (pathname.startsWith("/api/"))
      throw new HttpError(404, "no such API route");

    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      throw new HttpError(405, "method not allowed");
    }
    return serveStatic(req, res, { root: config.CLIENT_DIR, pathname });
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    route(req, res, url).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        logger.error({ err: error }, "unhandled request error");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        error: status === 500 ? "internal error" : error.message,
      });
    });
  };
}
