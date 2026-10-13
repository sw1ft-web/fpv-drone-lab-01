import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, stat } from "node:fs/promises";
import {
  monitorEventLoopDelay,
  performance as perfHooks,
} from "node:perf_hooks";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";
import { consoleLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { MatchManager } from "./matches.ts";
import { RoomError } from "./rooms.ts";
import type { RoomManager } from "./rooms.ts";
import { serveStatic } from "./static.ts";

const ROOM_BOTS = /^\/api\/rooms\/([a-z0-9][a-z0-9-]{0,63})\/bots$/;

/** Body of POST /api/rooms/:id/bots. */
const AddBotsBody = z.object({ count: z.number().int().min(1).max(32) });

const REPLAY_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Body of POST /api/rooms: the one place untrusted HTTP JSON becomes a typed value. */
const CreateRoomBody = z.object({
  name: z.string(),
  arenaId: z.string().default("arena-neon"),
  maxPlayers: z.number().optional(),
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** Reads a JSON body, refusing to buffer more than `limit` bytes. */
async function readJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "request body too large");
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk))
      throw new HttpError(400, "unexpected request body chunk");
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
export interface RequestHandlerOptions {
  config: ServerConfig;
  roomManager: RoomManager;
  matches?: MatchManager;
  stats: Record<string, number>;
  logger?: Logger;
}

export function createRequestHandler({
  config,
  roomManager,
  matches,
  stats,
  logger = consoleLogger,
}: RequestHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const startedAt = Date.now();
  // Utilization is reported for the interval since the previous /api/stats call,
  // so a load test (or a dashboard polling every few seconds) sees the recent load.
  let lastUtilization = perfHooks.eventLoopUtilization();

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        rooms: roomManager.size,
        players: roomManager.playerCount,
      });
      return;
    }

    if (pathname === "/api/stats") {
      const memory = process.memoryUsage();
      const utilization = perfHooks.eventLoopUtilization(lastUtilization);
      lastUtilization = perfHooks.eventLoopUtilization();
      sendJson(res, 200, {
        eventLoopUtilization: utilization.utilization,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
        eventLoopDelayMaxMs: loopDelay.max / 1e6,
        rooms: roomManager.size,
        players: roomManager.playerCount,
        ...stats,
        ...matches?.stats(),
      });
      return;
    }

    if (pathname === "/api/rooms") {
      if (method === "GET") {
        sendJson(res, 200, {
          rooms: roomManager.list(),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (method === "POST") {
        const raw = await readJsonBody(req, config.MAX_BODY_BYTES);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          throw new HttpError(400, "body must be a JSON object");
        }
        const body = CreateRoomBody.safeParse(raw);
        if (!body.success)
          throw new HttpError(
            400,
            `invalid room: ${body.error.issues[0]?.path.join(".") ?? "body"}`,
          );
        try {
          const room = roomManager.create({
            name: body.data.name,
            arenaId: body.data.arenaId,
            ...(body.data.maxPlayers === undefined
              ? {}
              : { maxPlayers: body.data.maxPlayers }),
          });
          sendJson(res, 201, room.toJSON());
          return;
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

    const botsMatch = ROOM_BOTS.exec(pathname);
    if (botsMatch) {
      const roomId = botsMatch[1] ?? "";
      if (!matches || !roomManager.get(roomId))
        throw new HttpError(404, "room not found");
      if (method === "POST") {
        const raw = await readJsonBody(req, config.MAX_BODY_BYTES);
        const body = AddBotsBody.safeParse(raw);
        if (!body.success)
          throw new HttpError(400, "count must be an integer from 1 to 32");
        const added = matches.addBots(roomId, body.data.count);
        sendJson(res, added > 0 ? 201 : 409, {
          added,
          bots: matches.get(roomId)?.botCount ?? 0,
        });
        return;
      }
      if (method === "DELETE") {
        sendJson(res, 200, { removed: matches.removeBots(roomId) });
        return;
      }
      res.setHeader("Allow", "POST, DELETE");
      throw new HttpError(405, "method not allowed");
    }

    if (pathname === "/api/replays" && method === "GET") {
      const files = await readdir(config.LOG_DIR).catch(() => []);
      const replays: { id: string; bytes: number }[] = [];
      for (const name of files.filter((file) => file.endsWith(".ndjson"))) {
        const info = await stat(join(config.LOG_DIR, name));
        replays.push({
          id: name.slice(0, -".ndjson".length),
          bytes: info.size,
        });
      }
      sendJson(res, 200, { replays });
      return;
    }

    const replayMatch = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replayMatch && method === "GET") {
      const id = decodeURIComponent(replayMatch[1] ?? "");
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
      await pipeline(createReadStream(file), res).catch((error: unknown) => {
        const code =
          error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
      });
      return;
    }

    if (config.DEBUG_ROUTES && pathname === "/api/slow") {
      const block = Number(url.searchParams.get("block") ?? 0);
      if (block > 0) {
        // Deliberate synchronous block: nothing else runs on this thread meanwhile.
        const until = performance.now() + Math.min(block, 5000);
        while (performance.now() < until);
        sendJson(res, 200, {
          ok: true,
          blockedMs: Math.min(block, 5000),
        });
        return;
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
    route(req, res, url).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        logger.error({ err: error }, "unhandled request error");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        error:
          status === 500 || !(error instanceof Error)
            ? "internal error"
            : error.message,
      });
    });
  };
}
