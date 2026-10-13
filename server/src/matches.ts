import { TICK_HZ } from "@fpv/shared";
import type { EntityId, InputEntry } from "@fpv/shared";
import { Match } from "./match.ts";
import type { MatchOptions, MatchSnapshot } from "./match.ts";
import type { Logger } from "./logger.ts";
import type { RoomManager, Room } from "./rooms.ts";
import { createTicker } from "./ticker.ts";
import type { Ticker, TickerOptions, TickerStats } from "./ticker.ts";

export interface MatchManagerOptions {
  roomManager: RoomManager;
  deliver: (playerId: string, snapshot: MatchSnapshot) => void;
  logger?: Pick<Logger, "info">;
  tickHz?: number;
  tickerOptions?: Partial<Omit<TickerOptions, "hz" | "onTick">>;
  matchOptions?: Partial<Omit<MatchOptions, "arenaId" | "onSnapshot">>;
}

export interface MatchStats {
  matches: number;
  matchPlayers: number;
  starvedSteps: number;
  droppedInputs: number;
  tick: TickerStats;
}

/**
 * Creates a Match when a room gets its first player, drives all matches from a
 * single 30 Hz ticker and discards the match when the room empties.
 */
export class MatchManager {
  readonly #matches = new Map<string, Match>();
  readonly deliver: MatchManagerOptions["deliver"];
  readonly logger: Pick<Logger, "info">;
  readonly matchOptions: NonNullable<MatchManagerOptions["matchOptions"]>;
  readonly ticker: Ticker;

  constructor({
    roomManager,
    deliver,
    logger = console,
    tickHz = TICK_HZ,
    tickerOptions = {},
    matchOptions = {},
  }: MatchManagerOptions) {
    this.deliver = deliver;
    this.logger = logger;
    this.matchOptions = matchOptions;
    this.ticker = createTicker({
      hz: tickHz,
      onTick: () => this.#tickAll(),
      ...tickerOptions,
    });

    const attach = (room: Room): void => {
      room.on("join", ({ player }) => this.#ensure(room).addPlayer(player.id));
      room.on("leave", ({ player }) =>
        this.#matches.get(room.id)?.removePlayer(player.id),
      );
      room.on("empty", () => this.#drop(room.id));
    };
    for (const { id } of roomManager.list()) {
      const room = roomManager.get(id);
      if (room) attach(room);
    }
    roomManager.on("roomCreated", attach);
    roomManager.on("roomRemoved", (room) => this.#drop(room.id));
  }

  #ensure(room: Room): Match {
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

  #drop(roomId: string): void {
    if (!this.#matches.delete(roomId)) return;
    this.logger.info({ roomId }, "match ended");
    if (this.#matches.size === 0) this.ticker.stop();
  }

  #tickAll(): void {
    for (const match of this.#matches.values()) match.tick();
  }

  get(roomId: string): Match | undefined {
    return this.#matches.get(roomId);
  }

  shipIdOf(roomId: string, playerId: string): EntityId | undefined {
    return this.#matches.get(roomId)?.shipIdOf(playerId);
  }

  receiveInputs(
    roomId: string,
    playerId: string,
    inputs: readonly InputEntry[],
  ): number {
    return this.#matches.get(roomId)?.receiveInputs(playerId, inputs) ?? 0;
  }

  stats(): MatchStats {
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

  close(): void {
    this.ticker.stop();
    this.#matches.clear();
  }
}
