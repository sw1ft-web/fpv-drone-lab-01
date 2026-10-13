import { TICK_HZ } from "@fpv/shared";
import { Match } from "./match.js";
import { createTicker } from "./ticker.js";

/**
 * Creates a Match when a room gets its first player, drives all matches from a
 * single 30 Hz ticker and discards the match when the room empties.
 */
export class MatchManager {
  #matches = new Map();

  constructor({
    roomManager,
    deliver,
    logger = console,
    tickHz = TICK_HZ,
    tickerOptions = {},
    matchOptions = {},
  }) {
    this.deliver = deliver;
    this.logger = logger;
    this.matchOptions = matchOptions;
    this.ticker = createTicker({
      hz: tickHz,
      onTick: () => this.#tickAll(),
      ...tickerOptions,
    });

    const attach = (room) => {
      room.on("join", ({ player }) => this.#ensure(room).addPlayer(player.id));
      room.on("leave", ({ player }) =>
        this.#matches.get(room.id)?.removePlayer(player.id),
      );
      room.on("empty", () => this.#drop(room.id));
    };
    for (const { id } of roomManager.list()) attach(roomManager.get(id));
    roomManager.on("roomCreated", attach);
    roomManager.on("roomRemoved", (room) => this.#drop(room.id));
  }

  #ensure(room) {
    let match = this.#matches.get(room.id);
    if (!match) {
      match = new Match({
        arenaId: room.arenaId,
        onSnapshot: (playerId, snapshot) => this.deliver(playerId, snapshot),
        ...this.matchOptions,
      });
      this.#matches.set(room.id, match);
      this.logger.info({ roomId: room.id, seed: match.seed }, "match started");
      this.ticker.start();
    }
    return match;
  }

  #drop(roomId) {
    if (!this.#matches.delete(roomId)) return;
    this.logger.info({ roomId }, "match ended");
    if (this.#matches.size === 0) this.ticker.stop();
  }

  #tickAll() {
    for (const match of this.#matches.values()) match.tick();
  }

  get(roomId) {
    return this.#matches.get(roomId);
  }

  shipIdOf(roomId, playerId) {
    return this.#matches.get(roomId)?.shipIdOf(playerId);
  }

  receiveInputs(roomId, playerId, inputs) {
    return this.#matches.get(roomId)?.receiveInputs(playerId, inputs) ?? 0;
  }

  stats() {
    let players = 0;
    let starved = 0;
    let dropped = 0;
    for (const match of this.#matches.values()) {
      players += match.playerCount;
      starved += match.starvedSteps;
      dropped += match.droppedInputs;
    }
    return {
      matches: this.#matches.size,
      matchPlayers: players,
      starvedSteps: starved,
      droppedInputs: dropped,
      tick: this.ticker.stats(),
    };
  }

  close() {
    this.ticker.stop();
    this.#matches.clear();
  }
}
