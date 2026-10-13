import { randomInt } from "node:crypto";
import { SIM_STEP, STEPS_PER_TICK, World, commandFromBits } from "@fpv/shared";
import type {
  EntityId,
  EntityView,
  InputEntry,
  IntegrateShip,
  SequencedCommand,
  Seq,
  Tick,
} from "@fpv/shared";
import { asSeq, asTick } from "@fpv/shared";
import { Bot } from "./bot.ts";
import type { PlayerInput } from "./bot.ts";

/** What the match hands to the transport for one player after every tick. */
export interface MatchSnapshot {
  readonly tick: Tick;
  readonly ack: Seq;
  readonly entities: readonly EntityView[];
}

export type SnapshotHandler = (
  playerId: string,
  snapshot: MatchSnapshot,
) => void;

export interface MatchOptions {
  arenaId: string;
  seed?: number;
  integrate?: IntegrateShip;
  onSnapshot?: SnapshotHandler;
  maxQueue?: number;
}

interface PlayerState {
  readonly shipId: EntityId;
  readonly queue: InputEntry[];
  lastReceivedSeq: number;
  ack: Seq;
}

/**
 * One authoritative match (one per occupied room).
 *
 * Clients send one input per simulation step, tagged with a sequence number.
 * Every server tick the match consumes up to STEPS_PER_TICK queued inputs per
 * player, steps the shared world, and broadcasts a snapshot that carries
 * `ack` = the last input of THAT player that has been applied. The client uses
 * the ack to throw away old predictions and replay the rest.
 *
 * A player with no queued input for a step simply does not move that step. We
 * never invent inputs, so a ship's trajectory is always a pure function of the
 * inputs the player really sent, which is exactly what the client predicts.
 */
export class Match {
  readonly #players = new Map<string, PlayerState>();
  /** Players whose input comes from code instead of a socket; they get no snapshots. */
  readonly #bots = new Map<string, { input: PlayerInput; seq: number }>();
  readonly arenaId: string;
  readonly seed: number;
  readonly world: World;
  readonly onSnapshot: SnapshotHandler;
  readonly maxQueue: number;
  tickNumber = 0;
  starvedSteps = 0;
  droppedInputs = 0;
  staleInputs = 0;

  constructor({
    arenaId,
    seed = randomInt(0, 2 ** 32),
    integrate,
    onSnapshot = () => {},
    maxQueue = 30,
  }: MatchOptions) {
    this.arenaId = arenaId;
    this.seed = seed;
    this.world = new World({
      seed,
      arenaId,
      ...(integrate ? { integrate } : {}),
    });
    this.world.populate();
    this.onSnapshot = onSnapshot;
    this.maxQueue = maxQueue;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  addPlayer(playerId: string): EntityId {
    const ship = this.world.addShip();
    this.#players.set(playerId, {
      shipId: ship.id,
      queue: [],
      lastReceivedSeq: 0,
      ack: asSeq(0),
    });
    return ship.id;
  }

  /** Adds a bot: a player like any other, except its inputs are generated here every tick. */
  addBot(
    playerId: string,
    seed = this.tickNumber + this.#bots.size + 1,
  ): EntityId {
    const shipId = this.addPlayer(playerId);
    this.#bots.set(playerId, {
      input: new Bot(this.world, shipId, seed),
      seq: 0,
    });
    return shipId;
  }

  removeBots(): number {
    const ids = [...this.#bots.keys()];
    for (const id of ids) this.removePlayer(id);
    return ids.length;
  }

  get botCount(): number {
    return this.#bots.size;
  }

  removePlayer(playerId: string): void {
    const player = this.#players.get(playerId);
    if (!player) return;
    this.#bots.delete(playerId);
    this.#players.delete(playerId);
    this.world.removeEntity(player.shipId);
  }

  shipIdOf(playerId: string): EntityId | undefined {
    return this.#players.get(playerId)?.shipId;
  }

  /** Queues validated inputs. Already-seen sequence numbers (redundant resends) are ignored. */
  receiveInputs(playerId: string, inputs: readonly InputEntry[]): number {
    const player = this.#players.get(playerId);
    if (!player) return 0;
    let accepted = 0;
    for (const input of inputs) {
      if (input.seq <= player.lastReceivedSeq) {
        this.staleInputs += 1;
        continue;
      }
      player.lastReceivedSeq = input.seq;
      if (player.queue.length >= this.maxQueue) {
        player.queue.shift();
        this.droppedInputs += 1;
      }
      player.queue.push(input);
      accepted += 1;
    }
    return accepted;
  }

  tick(): void {
    // A bot "sends" one input per simulation step through the same path as a human.
    for (const [botId, bot] of this.#bots) {
      const inputs: InputEntry[] = [];
      for (let step = 0; step < STEPS_PER_TICK; step += 1) {
        bot.seq += 1;
        inputs.push({ seq: asSeq(bot.seq), bits: bot.input.nextBits() });
      }
      this.receiveInputs(botId, inputs);
    }
    for (let step = 0; step < STEPS_PER_TICK; step += 1) {
      const commands = new Map<EntityId, SequencedCommand>();
      for (const player of this.#players.values()) {
        const input = player.queue.shift();
        if (!input) {
          this.starvedSteps += 1;
          continue;
        }
        player.ack = input.seq;
        commands.set(player.shipId, {
          ...commandFromBits(input.bits),
          seq: input.seq,
        });
      }
      this.world.step(SIM_STEP, commands);
    }
    this.tickNumber += 1;

    const entities = this.world.snapshotEntities();
    for (const [playerId, player] of this.#players) {
      if (this.#bots.has(playerId)) continue;
      this.onSnapshot(playerId, {
        tick: asTick(this.tickNumber),
        ack: player.ack,
        entities,
      });
    }
  }
}
