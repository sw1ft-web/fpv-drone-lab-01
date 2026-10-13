import assert from "node:assert/strict";
import { test } from "node:test";
import { Room, RoomError, RoomManager } from "../src/rooms.ts";

test("Room emits join, chat, leave and empty", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 2 });
  const events: string[] = [];
  room.on("join", () => events.push("join"));
  room.on("chat", () => events.push("chat"));
  room.on("leave", () => events.push("leave"));
  room.on("empty", () => events.push("empty"));

  const a = room.join("Ann");
  room.chat(a.id, "hello");
  room.leave(a.id);
  assert.deepEqual(events, ["join", "chat", "leave", "empty"]);
});

test("Room refuses players beyond maxPlayers", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 1 });
  room.join("Ann");
  assert.throws(
    () => room.join("Bob"),
    (error) => error instanceof RoomError && error.code === "room-full",
  );
});

test("RoomManager deletes empty rooms but keeps persistent ones", () => {
  const manager = new RoomManager();
  const temporary = manager.create({ name: "Temp" });
  const lasting = manager.create({ name: "Lasting", persistent: true });

  for (const room of [temporary, lasting]) {
    const player = room.join("Ann");
    room.leave(player.id);
  }
  assert.equal(manager.get(temporary.id), undefined);
  assert.ok(manager.get(lasting.id));
});

test("RoomManager enforces the room cap, unique ids and validation", () => {
  const manager = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 4 });
  manager.create({ name: "One" });
  manager.create({ name: "Two" });
  assert.throws(() => manager.create({ name: "Three" }), { code: "limit" });
  assert.throws(() => manager.create({ name: "One" }), { code: "exists" });
  manager.remove("two");
  assert.throws(() => manager.create({ name: "" }), { code: "invalid" });
  assert.throws(() => manager.create({ name: "Big", maxPlayers: 5 }), {
    code: "invalid",
  });
  assert.throws(() => manager.create({ name: "!!!" }), { code: "invalid" });
});
