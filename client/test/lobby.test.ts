import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { RoomsResponseSchema } from "../src/lobby/lobby.ts";

const room = {
  id: "kyiv-alpha",
  name: "Kyiv Alpha",
  arenaId: "arena-neon",
  players: 0,
  maxPlayers: 6,
};

describe("GET /api/rooms contract", () => {
  test("accepts the exact shape the server sends (ISO updatedAt) — regression found by e2e", () => {
    const parsed = RoomsResponseSchema.parse({
      rooms: [room],
      updatedAt: "2026-10-13T01:02:03.000Z",
    });
    assert.equal(parsed.rooms.length, 1);
    assert.equal(parsed.updatedAt, Date.parse("2026-10-13T01:02:03.000Z"));
  });

  test("still accepts epoch milliseconds, a missing timestamp and a bare array", () => {
    assert.equal(
      RoomsResponseSchema.parse({ rooms: [room], updatedAt: 5 }).updatedAt,
      5,
    );
    assert.equal(RoomsResponseSchema.parse({ rooms: [room] }).updatedAt, null);
    assert.equal(RoomsResponseSchema.parse([room]).rooms.length, 1);
  });

  test("rejects a garbage timestamp", () => {
    assert.throws(() =>
      RoomsResponseSchema.parse({ rooms: [room], updatedAt: "yesterday" }),
    );
  });
});
