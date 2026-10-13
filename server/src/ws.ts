import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { ARENA_HEIGHT, ARENA_WIDTH, SIM_HZ, TICK_HZ } from "@fpv/shared";
import { getCodec } from "@fpv/shared/codec";
import type { BinaryCodec, JsonCodec } from "@fpv/shared/codec";
import type { ServerMessageInput } from "@fpv/shared/protocol";
import { assertNever } from "@fpv/shared";
import type { ServerConfig } from "./config.ts";
import { consoleLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { MatchManager } from "./matches.ts";
import type { MatchSnapshot } from "./match.ts";
import {
  CLOSE,
  encodeServerMessage,
  frameBytes,
  parseClientMessage,
} from "./protocol.ts";
import { RoomError } from "./rooms.ts";
import type { Player, Room, RoomManager } from "./rooms.ts";
import { TokenBucket } from "./ratelimit.ts";

const OPEN = 1; // WebSocket.OPEN

/**
 * Sends a message unless the peer is too far behind (slow-client policy).
 * - critical messages (welcome/roster/error) are always queued, but a socket
 *   whose buffer exceeds 4x the limit is closed;
 * - non-critical messages (chat) are dropped once the buffer exceeds the limit.
 * Returns true if the message was queued.
 */
export interface SendOptions {
  critical?: boolean;
  maxBuffered: number;
  stats?: Stats;
}

export function safeSend(
  socket: WebSocket,
  message: ServerMessageInput,
  options: SendOptions,
): boolean {
  return safeSendEncoded(socket, encodeServerMessage(message), options);
}

/** Same policy as `safeSend` for an already-encoded frame (string or bytes). */
export function safeSendEncoded(
  socket: WebSocket,
  data: string | Uint8Array,
  { critical = false, maxBuffered, stats }: SendOptions,
): boolean {
  if (socket.readyState !== OPEN) return false;
  if (socket.bufferedAmount > maxBuffered * 4) {
    if (stats) stats.slowClientCloses += 1;
    socket.close(CLOSE.SLOW_CLIENT, "slow client");
    return false;
  }
  if (!critical && socket.bufferedAmount > maxBuffered) {
    if (stats) stats.droppedMessages += 1;
    return false;
  }
  socket.send(data);
  if (stats)
    stats.bytesOut +=
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  return true;
}

export type Stats = {
  connections: number;
  totalConnections: number;
  messagesIn: number;
  bytesIn: number;
  inputsIn: number;
  snapshotsSent: number;
  bytesOut: number;
  rejected: number;
  droppedMessages: number;
  slowClientCloses: number;
  heartbeatTerminations: number;
};

export function createStats(): Stats {
  return {
    connections: 0,
    totalConnections: 0,
    messagesIn: 0,
    bytesIn: 0,
    inputsIn: 0,
    snapshotsSent: 0,
    bytesOut: 0,
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
/** What the server remembers about one open socket. */
interface ConnectionState {
  readonly id: string;
  missedPongs: number;
  /** Set once `join` succeeded; `null` before that. */
  session: { readonly room: Room; readonly player: Player } | null;
  codec: JsonCodec | BinaryCodec;
  readonly bucket: TokenBucket;
}

export interface WebSocketOptions {
  server: Server;
  roomManager: RoomManager;
  matches: MatchManager;
  config: ServerConfig;
  logger?: Logger;
  stats?: Stats;
  /** Called with a low-cardinality reason whenever a connection is refused or dropped for cause. */
  onReject?: (reason: string) => void;
}

/** close code -> metric/log label */
const REJECT_REASON: Readonly<Record<number, string>> = {
  [CLOSE.TOO_BIG]: "too_big",
  [CLOSE.BAD_MESSAGE]: "bad_message",
  [CLOSE.UNKNOWN_TYPE]: "unknown_type",
  [CLOSE.JOIN_TIMEOUT]: "join_timeout",
  [CLOSE.RATE_LIMIT]: "rate_limit",
  [CLOSE.ROOM_UNAVAILABLE]: "room_unavailable",
  [CLOSE.SLOW_CLIENT]: "slow_client",
};

/**
 * Is a browser at `origin` allowed to open a socket to `host`?
 * No Origin header = not a browser (bots, curl, tests): allowed, because Origin
 * only protects against OTHER WEBSITES driving a visitor's browser.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === "") return true;
  if (allowed.includes("*")) return true;
  if (allowed.includes(origin)) return true;
  if (allowed.length > 0) return false;
  try {
    return new URL(origin).host === host; // same-origin only
  } catch {
    return false;
  }
}

/** The client address: X-Forwarded-For's first hop only when we sit behind a proxy we trust. */
export function clientIp(
  request: IncomingMessage,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export interface WebSocketEndpoint {
  readonly wss: WebSocketServer;
  readonly stats: Stats;
  deliverSnapshot(playerId: string, snapshot: MatchSnapshot): void;
  close(): Promise<void>;
}

export function attachWebSocketServer({
  server,
  roomManager,
  matches,
  config,
  logger = consoleLogger,
  stats = createStats(),
  onReject = () => {},
}: WebSocketOptions): WebSocketEndpoint {
  const connectionsByIp = new Map<string, number>();
  const refuse = (
    request: IncomingMessage,
    reason: string,
    detail: string,
  ): void => {
    stats.rejected += 1;
    onReject(reason);
    logger.warn(
      { reason, detail, remote: clientIp(request, config.TRUST_PROXY) },
      "ws.rejected",
    );
  };
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin, req }, done) => {
      if (!originAllowed(origin, req.headers.host, config.ALLOWED_ORIGINS)) {
        refuse(req, "origin", `origin ${origin} not allowed`);
        return done(false, 403, "origin not allowed");
      }
      const ip = clientIp(req, config.TRUST_PROXY);
      if ((connectionsByIp.get(ip) ?? 0) >= config.MAX_CONNECTIONS_PER_IP) {
        refuse(req, "ip_cap", `too many connections from ${ip}`);
        return done(false, 429, "too many connections");
      }
      done(true);
    },
  });
  const socketsByPlayer = new Map<string, WebSocket>(); // playerId -> socket
  const states = new Map<WebSocket, ConnectionState>();
  const send = (
    socket: WebSocket,
    message: ServerMessageInput,
    critical = false,
  ): boolean =>
    safeSend(socket, message, {
      critical,
      maxBuffered: config.MAX_BUFFERED_BYTES,
      stats,
    });

  const broadcast = (
    room: Room,
    message: ServerMessageInput,
    { critical = false, except }: { critical?: boolean; except?: string } = {},
  ): void => {
    for (const { id } of room.roster()) {
      if (id === except) continue;
      const socket = socketsByPlayer.get(id);
      if (socket) send(socket, message, critical);
    }
  };

  // Fan room events out to the sockets of that room.
  const attachRoom = (room: Room): void => {
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
  for (const { id } of roomManager.list()) {
    const room = roomManager.get(id);
    if (room) attachRoom(room);
  }
  roomManager.on("roomCreated", attachRoom);

  wss.on("error", (error) =>
    logger.error({ err: error }, "websocket server error"),
  );

  wss.on("connection", (socket, request) => {
    const state: ConnectionState = {
      id: randomUUID().slice(0, 8),
      missedPongs: 0,
      session: null,
      codec: getCodec("json"),
      bucket: new TokenBucket({
        capacity: config.RATE_CAPACITY,
        refillPerSec: config.RATE_REFILL_PER_SEC,
      }),
    };
    states.set(socket, state);
    stats.connections += 1;
    stats.totalConnections += 1;
    const remote = clientIp(request, config.TRUST_PROXY);
    connectionsByIp.set(remote, (connectionsByIp.get(remote) ?? 0) + 1);

    const reject = (
      code: number,
      reason: string,
      { notify = true }: { notify?: boolean } = {},
    ): void => {
      stats.rejected += 1;
      const label = REJECT_REASON[code] ?? "other";
      onReject(label);
      logger.warn(
        { conn: state.id, remote, code, reason: label, detail: reason },
        "ws.rejected",
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
      if (!state.session)
        reject(CLOSE.JOIN_TIMEOUT, "join message not received in time");
    }, config.JOIN_TIMEOUT_MS);

    const leaveRoom = (): void => {
      if (!state.session) return;
      const { room, player } = state.session;
      state.session = null;
      socketsByPlayer.delete(player.id);
      room.leave(player.id);
    };

    socket.on("message", (data, isBinary) => {
      stats.messagesIn += 1;
      stats.bytesIn += frameBytes(data);
      if (!state.bucket.take())
        return reject(CLOSE.RATE_LIMIT, "rate limit exceeded");

      const parsed = parseClientMessage(data, isBinary);
      if (!parsed.ok) return reject(parsed.code, parsed.reason);
      const { message } = parsed;

      switch (message.type) {
        case "join": {
          if (state.session) return reject(CLOSE.BAD_MESSAGE, "already joined");
          const room = roomManager.get(message.roomId);
          if (!room) return reject(CLOSE.ROOM_UNAVAILABLE, "no such room");
          let player: Player;
          try {
            player = room.join(message.name);
          } catch (error) {
            if (error instanceof RoomError)
              return reject(CLOSE.ROOM_UNAVAILABLE, error.message);
            throw error;
          }
          const shipId = matches.shipIdOf(room.id, player.id);
          if (shipId === undefined) {
            room.leave(player.id);
            return reject(CLOSE.ROOM_UNAVAILABLE, "match unavailable");
          }
          clearTimeout(joinTimer);
          logger.info(
            {
              conn: state.id,
              roomId: room.id,
              playerId: player.id,
              name: player.name,
            },
            "player.joined",
          );
          state.session = { room, player };
          state.codec = getCodec(message.codec);
          socketsByPlayer.set(player.id, socket);
          send(
            socket,
            {
              type: "welcome",
              playerId: player.id,
              shipId,
              room: room.toJSON(),
              roster: room.roster(),
              codec: state.codec.name,
              tickHz: TICK_HZ,
              simHz: SIM_HZ,
              arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
            },
            true,
          );
          break;
        }
        case "input": {
          const { session } = state;
          if (!session) return reject(CLOSE.BAD_MESSAGE, "join a room first");
          stats.inputsIn += message.inputs.length;
          matches.receiveInputs(
            session.room.id,
            session.player.id,
            message.inputs,
          );
          break;
        }
        case "chat": {
          const { session } = state;
          if (!session) return reject(CLOSE.BAD_MESSAGE, "join a room first");
          session.room.chat(session.player.id, message.text);
          break;
        }
        case "leave":
          leaveRoom();
          socket.close(CLOSE.NORMAL, "bye");
          break;
        default:
          return assertNever(message, "unhandled client message");
      }
    });

    socket.on("close", () => {
      states.delete(socket);
      clearTimeout(joinTimer);
      stats.connections -= 1;
      const left = (connectionsByIp.get(remote) ?? 1) - 1;
      if (left <= 0) connectionsByIp.delete(remote);
      else connectionsByIp.set(remote, left);
      leaveRoom();
    });
  });

  // Ping every HEARTBEAT_MS; a socket that missed two pongs is terminated.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (!state) continue;
      if (state.missedPongs >= 2) {
        stats.heartbeatTerminations += 1;
        onReject("heartbeat");
        logger.warn({ conn: state.id, reason: "heartbeat" }, "ws.rejected");
        socket.terminate();
        continue;
      }
      state.missedPongs += 1;
      socket.ping();
    }
  }, config.HEARTBEAT_MS);
  heartbeat.unref();

  /** Called by the match for every player on every tick. Snapshots are droppable (non-critical). */
  const deliverSnapshot = (playerId: string, snapshot: MatchSnapshot): void => {
    const socket = socketsByPlayer.get(playerId);
    const state = socket && states.get(socket);
    if (!socket || !state) return;
    const sent = safeSendEncoded(socket, state.codec.encodeSnapshot(snapshot), {
      critical: false,
      maxBuffered: config.MAX_BUFFERED_BYTES,
      stats,
    });
    if (sent) stats.snapshotsSent += 1;
  };

  return {
    wss,
    stats,
    deliverSnapshot,
    async close(): Promise<void> {
      clearInterval(heartbeat);
      for (const socket of wss.clients) {
        send(
          socket,
          {
            type: "shutdown",
            message: "server is shutting down",
            retryAfterMs: 2000,
          },
          true,
        );
        socket.close(CLOSE.GOING_AWAY, "server shutting down");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
