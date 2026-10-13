import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { z } from "zod";
import { SIM_STEP, World, asSeq, commandFromBits } from "@fpv/shared";
import { Bot } from "../src/bot.ts";
import { Match } from "../src/match.ts";
import { startTestServer } from "./helpers.ts";
import type { TestServer } from "./helpers.ts";

describe("Bot", () => {
  test("a bot flies: its ship moves and it shoots", () => {
    const match = new Match({ arenaId: "arena-neon", seed: 3 });
    match.addBot("bot-1", 11);
    match.addBot("bot-2", 12);
    const ship = [...match.world.ships()][0];
    assert.ok(ship);
    const start = { ...ship.pos };
    let fired = 0;
    match.world.bus.on("fired", () => (fired += 1));
    for (let i = 0; i < 300; i += 1) match.tick();
    assert.ok(Math.hypot(ship.pos.x - start.x, ship.pos.y - start.y) > 10);
    assert.ok(fired > 0, "bots shoot");
  });

  test("bots go through the same input queue as humans (acks advance)", () => {
    const match = new Match({ arenaId: "arena-neon", seed: 3 });
    match.addBot("bot-1", 1);
    match.tick();
    match.tick();
    // 2 ticks x STEPS_PER_TICK inputs have been consumed, none starved.
    assert.equal(match.starvedSteps, 0);
    assert.equal(match.botCount, 1);
  });

  test("bots never receive snapshots", () => {
    const received: string[] = [];
    const match = new Match({
      arenaId: "arena-neon",
      seed: 3,
      onSnapshot: (id) => received.push(id),
    });
    match.addBot("bot-1", 1);
    match.addPlayer("human");
    match.tick();
    assert.deepEqual(received, ["human"]);
  });

  test("removeBots leaves humans alone", () => {
    const match = new Match({ arenaId: "arena-neon", seed: 3 });
    match.addBot("bot-1", 1);
    match.addPlayer("human");
    assert.equal(match.removeBots(), 1);
    assert.equal(match.playerCount, 1);
  });

  test("an inactive or missing ship produces no input", () => {
    const world = new World({ seed: 1 });
    const ship = world.addShip();
    const bot = new Bot(world, ship.id, 1);
    ship.respawnTimer = 1;
    assert.equal(bot.nextBits(), 0);
    world.removeEntity(ship.id);
    assert.equal(bot.nextBits(), 0);
  });

  test("bot input is always a valid command", () => {
    const world = new World({ seed: 5 });
    world.populate();
    const ship = world.addShip();
    world.addShip();
    const bot = new Bot(world, ship.id, 5);
    for (let i = 0; i < 600; i += 1) {
      const bits = bot.nextBits();
      assert.ok(bits >= 0 && bits <= 31);
      world.step(
        SIM_STEP,
        new Map([[ship.id, { ...commandFromBits(bits), seq: asSeq(i + 1) }]]),
      );
    }
  });
});

describe("POST /api/rooms/:id/bots", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.stop());

  const Added = z.object({ added: z.number(), bots: z.number() });
  const post = (path: string, body: unknown) =>
    fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("adds bots up to the room capacity", async () => {
    const response = await post("/api/rooms/training-01/bots", { count: 32 });
    assert.equal(response.status, 201);
    const body = Added.parse(await response.json());
    assert.equal(body.added, 4); // training-01 holds 4
    const again = await post("/api/rooms/training-01/bots", { count: 1 });
    assert.equal(again.status, 409);
    const stats = z
      .object({ matchPlayers: z.number() })
      .parse(await (await fetch(`${server.origin}/api/stats`)).json());
    assert.equal(stats.matchPlayers, 4);
  });

  test("validates input and the room", async () => {
    assert.equal(
      (await post("/api/rooms/nope/bots", { count: 1 })).status,
      404,
    );
    assert.equal(
      (await post("/api/rooms/night-run/bots", { count: 0 })).status,
      400,
    );
    assert.equal(
      (await post("/api/rooms/night-run/bots", { count: "x" })).status,
      400,
    );
  });

  test("DELETE removes the bots", async () => {
    const response = await fetch(
      `${server.origin}/api/rooms/training-01/bots`,
      {
        method: "DELETE",
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removed: 4 });
  });
});
