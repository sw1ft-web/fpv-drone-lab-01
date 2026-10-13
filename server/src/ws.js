import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { CLOSE, encodeServerMessage, parseClientMessage } from "./protocol.js";
import { RoomError } from "./rooms.js";
import { TokenBucket } from "./ratelimit.js";

const OPEN = 1; // WebSocket.OPEN

/**
 * Sends a message unless the peer is too far behind (slow-client policy).
 * - critical messages (welcome/roster/error) are always queued, but a socket
 *   whose buffer exceeds 4x the limit is closed;
 * - non-critical messages (chat) are dropped once the buffer exceeds the limit.
 * Returns true if the message was queued.
 */
export function safeSend(
  socket,
  message,
  { critical = false, maxBuffered, stats } = {},
) {
  if (socket.readyState !== OPEN) return false;
  if (socket.bufferedAmount > maxBuffered * 4) {
    stats && (stats.slowClientCloses += 1);
    socket.close(CLOSE.SLOW_CLIENT, "slow client");
    return false;
  }
  if (!critical && socket.bufferedAmount > maxBuffered) {
    stats && (stats.droppedMessages += 1);
    return false;
  }
  socket.send(encodeServerMessage(message));
  return true;
}

export function createStats() {
  return {
    connections: 0,
    totalConnections: 0,
    messagesIn: 0,
    rejected: 0,
    droppedMessages: 0,
    slowClientCloses: 0,
    heartbeatTerminations: 0,
  };
}

/**
 * Attaches the WebSocket endpoint `/ws` to an existing http.Server.
 * One `ConnectionState` per socket tracks the heartbeat, the rate limit bucket
 * and (after `join`) the room membership.
 */
export function attachWebSocketServer({
  server,
  roomManager,
  config,
  logger = console,
  stats = createStats(),
}) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.MAX_PAYLOAD_BYTES,
  });
  const socketsByPlayer = new Map(); // playerId -> socket
  const send = (socket, message, critical = false) =>
    safeSend(socket, message, {
      critical,
      maxBuffered: config.MAX_BUFFERED_BYTES,
      stats,
    });

  const broadcast = (room, message, { critical = false, except } = {}) => {
    for (const { id } of room.roster()) {
      if (id === except) continue;
      const socket = socketsByPlayer.get(id);
      if (socket) send(socket, message, critical);
    }
  };

  // Fan room events out to the sockets of that room.
  const attachRoom = (room) => {
    room.on("join", () =>
      broadcast(
        room,
        { type: "roster", roster: room.roster() },
        { critical: true },
      ),
    );
    room.on("leave", () =>
      broadcast(
        room,
        { type: "roster", roster: room.roster() },
        { critical: true },
      ),
    );
    room.on("chat", ({ from, text, t }) =>
      broadcast(room, { type: "chat", from, text, t }),
    );
  };
  for (const room of roomManager.list()) attachRoom(roomManager.get(room.id));
  roomManager.on("roomCreated", attachRoom);

  wss.on("error", (error) =>
    logger.error({ err: error }, "websocket server error"),
  );

  wss.on("connection", (socket, request) => {
    const state = {
      id: randomUUID().slice(0, 8),
      missedPongs: 0,
      room: null,
      player: null,
      bucket: new TokenBucket({
        capacity: config.RATE_CAPACITY,
        refillPerSec: config.RATE_REFILL_PER_SEC,
      }),
    };
    socket.state = state;
    stats.connections += 1;
    stats.totalConnections += 1;
    const remote = request.socket.remoteAddress;

    const reject = (code, reason, { notify = true } = {}) => {
      stats.rejected += 1;
      logger.warn(
        { conn: state.id, remote, code, reason },
        "closing connection",
      );
      if (notify) send(socket, { type: "error", code, message: reason }, true);
      socket.close(code, reason.slice(0, 120));
    };

    // Every socket needs an error listener: an unhandled 'error' event would crash the process.
    socket.on("error", (error) =>
      logger.warn({ conn: state.id, err: error.message }, "socket error"),
    );
    socket.on("pong", () => {
      state.missedPongs = 0;
    });

    const joinTimer = setTimeout(() => {
      if (!state.room)
        reject(CLOSE.JOIN_TIMEOUT, "join message not received in time");
    }, config.JOIN_TIMEOUT_MS);

    const leaveRoom = () => {
      if (!state.room) return;
      const { room, player } = state;
      state.room = null;
      state.player = null;
      socketsByPlayer.delete(player.id);
      room.leave(player.id);
    };

    socket.on("message", (data, isBinary) => {
      stats.messagesIn += 1;
      if (!state.bucket.take())
        return reject(CLOSE.RATE_LIMIT, "rate limit exceeded");

      const parsed = parseClientMessage(data, isBinary);
      if (!parsed.ok) return reject(parsed.code, parsed.reason);
      const { message } = parsed;

      switch (message.type) {
        case "join": {
          if (state.room) return reject(CLOSE.BAD_MESSAGE, "already joined");
          const room = roomManager.get(message.roomId);
          if (!room) return reject(CLOSE.ROOM_UNAVAILABLE, "no such room");
          let player;
          try {
            player = room.join(message.name);
          } catch (error) {
            if (error instanceof RoomError)
              return reject(CLOSE.ROOM_UNAVAILABLE, error.message);
            throw error;
          }
          clearTimeout(joinTimer);
          state.room = room;
          state.player = player;
          socketsByPlayer.set(player.id, socket);
          send(
            socket,
            {
              type: "welcome",
              playerId: player.id,
              room: room.toJSON(),
              roster: room.roster(),
            },
            true,
          );
          break;
        }
        case "chat":
          if (!state.room)
            return reject(CLOSE.BAD_MESSAGE, "join a room first");
          state.room.chat(state.player.id, message.text);
          break;
        case "leave":
          leaveRoom();
          socket.close(CLOSE.NORMAL, "bye");
          break;
      }
    });

    socket.on("close", () => {
      clearTimeout(joinTimer);
      stats.connections -= 1;
      leaveRoom();
    });
  });

  // Ping every HEARTBEAT_MS; a socket that missed two pongs is terminated.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.state.missedPongs >= 2) {
        stats.heartbeatTerminations += 1;
        logger.warn({ conn: socket.state.id }, "terminating: missed two pongs");
        socket.terminate();
        continue;
      }
      socket.state.missedPongs += 1;
      socket.ping();
    }
  }, config.HEARTBEAT_MS);
  heartbeat.unref();

  return {
    wss,
    stats,
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients)
        socket.close(CLOSE.GOING_AWAY, "server shutting down");
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
