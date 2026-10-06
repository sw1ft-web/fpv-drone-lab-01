import { combineSignals, fetchJson } from "../assets/http.js";

export class Lobby extends EventTarget {
  #rooms = [];
  #visible = false;
  #intervalId = 0;
  #sessionController = null;

  constructor({ url = "/api/rooms", refreshMs = 4000, timeoutMs = 1800 } = {}) {
    super();
    this.url = url;
    this.refreshMs = refreshMs;
    this.timeoutMs = timeoutMs;
  }

  get rooms() {
    return [...this.#rooms];
  }

  get visible() {
    return this.#visible;
  }

  async show() {
    if (this.#visible) return;
    this.#visible = true;
    this.#sessionController = new AbortController();
    this.dispatchEvent(new CustomEvent("status", { detail: "Refreshing rooms…" }));

    await this.refresh().catch((error) => {
      if (error?.name !== "AbortError" && error?.name !== "TimeoutError") {
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      }
    });

    if (!this.#visible) return;
    this.#intervalId = window.setInterval(() => {
      this.refresh().catch((error) => {
        if (error?.name !== "AbortError" && error?.name !== "TimeoutError") {
          this.dispatchEvent(new CustomEvent("error", { detail: error }));
        }
      });
    }, this.refreshMs);
  }

  async refresh() {
    if (!this.#visible || !this.#sessionController) return;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = combineSignals([this.#sessionController.signal, timeoutSignal]);
    const payload = await fetchJson(this.url, { signal });
    this.#rooms = Array.isArray(payload) ? payload : payload.rooms ?? [];

    this.dispatchEvent(
      new CustomEvent("roomsChanged", {
        detail: { rooms: this.rooms, updatedAt: payload.updatedAt ?? null },
      }),
    );
    this.dispatchEvent(new CustomEvent("status", { detail: "Rooms are up to date" }));
  }

  join(roomId, playerName) {
    const name = playerName.trim();
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (!name) throw new Error("Enter a player name");
    if (!room) throw new Error("Choose an available room");
    if (room.players >= room.maxPlayers) throw new Error("This room is full");

    this.dispatchEvent(new CustomEvent("joined", { detail: { room, playerName: name } }));
  }

  leave() {
    if (!this.#visible) return;
    this.#visible = false;
    window.clearInterval(this.#intervalId);
    this.#intervalId = 0;
    this.#sessionController?.abort(new DOMException("Lobby closed", "AbortError"));
    this.#sessionController = null;
    this.dispatchEvent(new Event("left"));
  }
}
