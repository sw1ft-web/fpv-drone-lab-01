import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { NAME_MAX, ROOM_ID_PATTERN } from "@fpv/shared/protocol";
import type { PlayerInfo, RoomInfo } from "@fpv/shared/protocol";

export type RoomErrorCode = "room-full" | "invalid" | "exists" | "limit";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export type Player = PlayerInfo;

export interface ChatEvent {
  from: string;
  playerId: string;
  text: string;
  t: number;
}

/** Events a Room emits: the key is the event name, the tuple is the listener's argument list. */
export type RoomEvents = {
  join: [{ player: Player }];
  leave: [{ player: Player }];
  chat: [ChatEvent];
  empty: [];
};

export type RoomManagerEvents = {
  roomCreated: [Room];
  roomRemoved: [Room];
};

export interface RoomOptions {
  id: string;
  name: string;
  arenaId?: string;
  maxPlayers?: number;
  persistent?: boolean;
}

/**
 * A room is a plain EventEmitter: it knows nothing about sockets. Transport
 * code (ws.js) and the match log subscribe to its events.
 *
 * Events: `join` {player}, `leave` {player}, `chat` {from, text, t}, `empty`.
 */
export class Room extends EventEmitter<RoomEvents> {
  readonly #players = new Map<string, Player>();
  readonly id: string;
  readonly name: string;
  readonly arenaId: string;
  readonly maxPlayers: number;
  readonly persistent: boolean;
  readonly createdAt: number;

  constructor({
    id,
    name,
    arenaId = "arena-neon",
    maxPlayers = 8,
    persistent = false,
  }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.arenaId = arenaId;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
    this.createdAt = Date.now();
  }

  get size(): number {
    return this.#players.size;
  }

  get isFull(): boolean {
    return this.#players.size >= this.maxPlayers;
  }

  has(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  join(name: string): Player {
    if (this.isFull)
      throw new RoomError("room-full", `room ${this.id} is full`);
    const player: Player = { id: randomUUID().slice(0, 8), name };
    this.#players.set(player.id, player);
    this.emit("join", { player });
    return player;
  }

  leave(playerId: string): boolean {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.#players.delete(playerId);
    this.emit("leave", { player });
    if (this.#players.size === 0) this.emit("empty");
    return true;
  }

  chat(playerId: string, text: string): boolean {
    const player = this.#players.get(playerId);
    if (!player) return false;
    this.emit("chat", { from: player.name, playerId, text, t: Date.now() });
    return true;
  }

  roster(): Player[] {
    return [...this.#players.values()].map(({ id, name }) => ({ id, name }));
  }

  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arenaId: this.arenaId,
    };
  }
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * Owns all rooms. Deletes a non-persistent room as soon as it becomes empty.
 * Events: `roomCreated` (room), `roomRemoved` (room).
 */
export interface RoomManagerOptions {
  maxRooms?: number;
  maxPlayersPerRoom?: number;
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;

  constructor({
    maxRooms = 20,
    maxPlayersPerRoom = 8,
  }: RoomManagerOptions = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get playerCount(): number {
    let total = 0;
    for (const room of this.#rooms.values()) total += room.size;
    return total;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((room) => room.toJSON());
  }

  create({
    id,
    name,
    arenaId = "arena-neon",
    maxPlayers = Math.min(6, this.maxPlayersPerRoom),
    persistent = false,
  }: Omit<RoomOptions, "id"> & { id?: string | undefined }): Room {
    if (name.trim().length < 1 || name.trim().length > NAME_MAX + 6) {
      throw new RoomError("invalid", "room name must be 1-24 characters");
    }
    const roomId = id ?? slugify(name);
    if (!ROOM_ID_PATTERN.test(roomId))
      throw new RoomError("invalid", "room name has no usable characters");
    if (!/^[a-z0-9-]{1,40}$/.test(arenaId)) {
      throw new RoomError("invalid", "invalid arenaId");
    }
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < 1 ||
      maxPlayers > this.maxPlayersPerRoom
    ) {
      throw new RoomError(
        "invalid",
        `maxPlayers must be an integer in [1, ${this.maxPlayersPerRoom}]`,
      );
    }
    if (this.#rooms.has(roomId))
      throw new RoomError("exists", `room ${roomId} already exists`);
    if (this.#rooms.size >= this.maxRooms)
      throw new RoomError("limit", "room limit reached");

    const room = new Room({
      id: roomId,
      name: name.trim(),
      arenaId,
      maxPlayers,
      persistent,
    });
    this.#rooms.set(roomId, room);
    room.on("empty", () => {
      if (!room.persistent) this.remove(room.id);
    });
    this.emit("roomCreated", room);
    return room;
  }

  remove(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.emit("roomRemoved", room);
    return true;
  }
}
