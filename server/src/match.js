import { randomInt } from "node:crypto";
import { SIM_STEP, STEPS_PER_TICK, World, commandFromBits } from "@fpv/shared";

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
  #players = new Map();

  constructor({
    arenaId,
    seed = randomInt(0, 2 ** 32),
    integrate,
    onSnapshot = () => {},
    maxQueue = 30,
  } = {}) {
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
    this.tickNumber = 0;
    this.starvedSteps = 0;
    this.droppedInputs = 0;
    this.staleInputs = 0;
  }

  get playerCount() {
    return this.#players.size;
  }

  addPlayer(playerId) {
    const ship = this.world.addShip();
    this.#players.set(playerId, {
      shipId: ship.id,
      queue: [],
      lastReceivedSeq: 0,
      ack: 0,
    });
    return ship.id;
  }

  removePlayer(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return;
    this.#players.delete(playerId);
    this.world.removeEntity(player.shipId);
  }

  shipIdOf(playerId) {
    return this.#players.get(playerId)?.shipId;
  }

  /** Queues validated inputs. Already-seen sequence numbers (redundant resends) are ignored. */
  receiveInputs(playerId, inputs) {
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

  tick() {
    for (let step = 0; step < STEPS_PER_TICK; step += 1) {
      const commands = new Map();
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
      this.onSnapshot(playerId, {
        tick: this.tickNumber,
        ack: player.ack,
        entities,
      });
    }
  }
}
