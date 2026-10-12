import { Bus } from "@fpv/shared";
import { RoomInfoSchema } from "@fpv/shared/protocol";
import type { RoomInfo } from "@fpv/shared/protocol";
import { z } from "zod";
import {
  combineSignals,
  fetchJson,
  isAbortError,
  postJson,
} from "../assets/http.ts";

/** GET /api/rooms: `{ rooms: [...] }` (a bare array is accepted too). */
export const RoomsResponseSchema = z.union([
  z.array(RoomInfoSchema).transform((rooms) => ({ rooms, updatedAt: null })),
  z.object({
    rooms: z.array(RoomInfoSchema),
    // The server sends an ISO-8601 string; older servers sent epoch milliseconds.
    updatedAt: z
      .union([z.number(), z.iso.datetime().transform((iso) => Date.parse(iso))])
      .nullish()
      .transform((value) => value ?? null),
  }),
]);

export type LobbyEvents = {
  status: string;
  error: Error;
  roomsChanged: { rooms: RoomInfo[]; updatedAt: number | null };
  joined: { room: RoomInfo; playerName: string };
  left: undefined;
};

export interface LobbyOptions {
  url?: string;
  refreshMs?: number;
  timeoutMs?: number;
}

export interface NewRoom {
  name: string;
  arenaId?: string;
  maxPlayers?: number;
}

export class Lobby {
  readonly events = new Bus<LobbyEvents>();
  readonly url: string;
  readonly refreshMs: number;
  readonly timeoutMs: number;

  #rooms: RoomInfo[] = [];
  #visible = false;
  #intervalId = 0;
  #sessionController: AbortController | null = null;

  constructor({
    url = "/api/rooms",
    refreshMs = 4000,
    timeoutMs = 1800,
  }: LobbyOptions = {}) {
    this.url = url;
    this.refreshMs = refreshMs;
    this.timeoutMs = timeoutMs;
  }

  get rooms(): RoomInfo[] {
    return [...this.#rooms];
  }

  get visible(): boolean {
    return this.#visible;
  }

  #report(error: unknown): void {
    if (isAbortError(error)) return;
    this.events.emit(
      "error",
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  async show(): Promise<void> {
    if (this.#visible) return;
    this.#visible = true;
    this.#sessionController = new AbortController();
    this.events.emit("status", "Refreshing rooms…");

    await this.refresh().catch((error: unknown) => this.#report(error));

    if (!this.visible) return; // the lobby may have been left while we awaited
    this.#intervalId = window.setInterval(() => {
      this.refresh().catch((error: unknown) => this.#report(error));
    }, this.refreshMs);
  }

  async refresh(): Promise<void> {
    if (!this.#visible || !this.#sessionController) return;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = combineSignals([
      this.#sessionController.signal,
      timeoutSignal,
    ]);
    const payload = RoomsResponseSchema.parse(
      await fetchJson(this.url, { signal }),
    );
    this.#rooms = payload.rooms;

    this.events.emit("roomsChanged", {
      rooms: this.rooms,
      updatedAt: payload.updatedAt,
    });
    this.events.emit("status", "Rooms are up to date");
  }

  async createRoom({
    name,
    arenaId = "arena-neon",
    maxPlayers = 6,
  }: NewRoom): Promise<{ id: string; name: string }> {
    const room = z
      .object({ id: z.string(), name: z.string() })
      .parse(await postJson(this.url, { name, arenaId, maxPlayers }));
    await this.refresh();
    return room;
  }

  join(roomId: string, playerName: string): void {
    const name = playerName.trim();
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!name) throw new Error("Enter a player name");
    if (!room) throw new Error("Choose an available room");
    if (room.players >= room.maxPlayers) throw new Error("This room is full");

    this.events.emit("joined", { room, playerName: name });
  }

  leave(): void {
    if (!this.#visible) return;
    this.#visible = false;
    window.clearInterval(this.#intervalId);
    this.#intervalId = 0;
    this.#sessionController?.abort(
      new DOMException("Lobby closed", "AbortError"),
    );
    this.#sessionController = null;
    this.events.emit("left", undefined);
  }
}
