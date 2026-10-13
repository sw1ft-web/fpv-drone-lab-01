import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import type { ServerConfig } from "./config.ts";
import { createRequestHandler } from "./http.ts";
import { attachMatchLog } from "./log/matchlog.ts";
import type { MatchLog } from "./log/matchlog.ts";
import { consoleLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import { MatchManager } from "./matches.ts";
import { RoomManager } from "./rooms.ts";
import { attachWebSocketServer, createStats } from "./ws.ts";
import type { Stats, WebSocketEndpoint } from "./ws.ts";

const DEFAULT_ROOMS: readonly {
  id: string;
  name: string;
  arenaId: string;
  maxPlayers: number;
}[] = [
  {
    id: "kyiv-alpha",
    name: "Kyiv Alpha",
    arenaId: "arena-neon",
    maxPlayers: 6,
  },
  {
    id: "training-01",
    name: "Training 01",
    arenaId: "arena-training",
    maxPlayers: 4,
  },
  { id: "night-run", name: "Night Run", arenaId: "arena-neon", maxPlayers: 8 },
];

/**
 * Wires HTTP + WebSocket + rooms + match logs together.
 * Returns `{ server, roomManager, listen(), close() }`; nothing starts listening
 * until `listen()` is called, which keeps the server easy to test.
 */
export interface App {
  readonly server: Server;
  readonly roomManager: RoomManager;
  readonly matches: MatchManager;
  readonly stats: Stats;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createApp(
  config: ServerConfig,
  { logger = consoleLogger }: { logger?: Logger } = {},
): App {
  const roomManager = new RoomManager({
    maxRooms: config.MAX_ROOMS,
    maxPlayersPerRoom: config.MAX_PLAYERS_PER_ROOM,
  });
  const stats = createStats();
  const matchLogs = new Map<
    string,
    Pick<MatchLog, "close"> | { close(): Promise<void> }
  >();
  const onLogError = (error: unknown): void =>
    logger.error({ err: error }, "match log failed");

  roomManager.on("roomCreated", (room) => {
    matchLogs.set(
      room.id,
      attachMatchLog(room, config.LOG_DIR, { onError: onLogError }),
    );
  });
  roomManager.on("roomRemoved", (room) => {
    const log = matchLogs.get(room.id);
    matchLogs.delete(room.id);
    log?.close().catch(onLogError);
  });

  for (const spec of DEFAULT_ROOMS) {
    roomManager.create({
      ...spec,
      maxPlayers: Math.min(spec.maxPlayers, config.MAX_PLAYERS_PER_ROOM),
      persistent: true,
    });
  }

  let sockets: WebSocketEndpoint | null = null;
  const matches = new MatchManager({
    roomManager,
    logger,
    tickerOptions: { spinMs: config.TICK_SPIN_MS },
    deliver: (playerId, snapshot) =>
      sockets?.deliverSnapshot(playerId, snapshot),
  });
  const server = createServer(
    createRequestHandler({ config, roomManager, matches, stats, logger }),
  );
  sockets = attachWebSocketServer({
    server,
    roomManager,
    matches,
    config,
    logger,
    stats,
  });

  return {
    server,
    roomManager,
    matches,
    stats,
    listen(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.PORT, config.HOST, () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string")
            reject(new Error("server is not listening on a TCP port"));
          else resolve(address);
        });
      });
    },
    /** Stop accepting connections, close sockets, flush match logs. */
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      matches.close();
      await sockets.close();
      await Promise.all([...matchLogs.values()].map((log) => log.close()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      await closed;
      clearTimeout(timer);
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  const address = await app.listen();
  consoleLogger.info(
    { port: address.port, logDir: config.LOG_DIR },
    "server listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    consoleLogger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      consoleLogger.error({}, "shutdown timed out");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await app.close();
    consoleLogger.info({}, "shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
