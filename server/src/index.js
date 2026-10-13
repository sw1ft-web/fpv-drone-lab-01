import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRequestHandler } from "./http.js";
import { attachMatchLog } from "./log/matchlog.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocketServer, createStats } from "./ws.js";

const DEFAULT_ROOMS = [
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

const consoleLogger = {
  info: (fields, message) =>
    console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (fields, message) =>
    console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (fields, message) =>
    console.error(
      JSON.stringify({
        level: "error",
        message,
        ...fields,
        err: fields?.err?.stack ?? fields?.err,
      }),
    ),
};

/**
 * Wires HTTP + WebSocket + rooms + match logs together.
 * Returns `{ server, roomManager, listen(), close() }`; nothing starts listening
 * until `listen()` is called, which keeps the server easy to test.
 */
export function createApp(config, { logger = consoleLogger } = {}) {
  const roomManager = new RoomManager({
    maxRooms: config.MAX_ROOMS,
    maxPlayersPerRoom: config.MAX_PLAYERS_PER_ROOM,
  });
  const stats = createStats();
  const matchLogs = new Map();
  const onLogError = (error) =>
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

  const server = createServer(
    createRequestHandler({ config, roomManager, stats, logger }),
  );
  const sockets = attachWebSocketServer({
    server,
    roomManager,
    config,
    logger,
    stats,
  });

  return {
    server,
    roomManager,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.PORT, config.HOST, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    /** Stop accepting connections, close sockets, flush match logs. */
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      await sockets.close();
      await Promise.all([...matchLogs.values()].map((log) => log.close()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      await closed;
      clearTimeout(timer);
    },
  };
}

async function main() {
  const config = loadConfig();
  const app = createApp(config);
  const address = await app.listen();
  consoleLogger.info(
    { port: address.port, logDir: config.LOG_DIR },
    "server listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
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
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
