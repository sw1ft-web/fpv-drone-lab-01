import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { attachMatchLog, createMatchLog } from "../src/log/matchlog.ts";
import { ReplayParseError, replayEvents } from "../src/log/replay.ts";
import { Room } from "../src/rooms.ts";

test("createMatchLog writes NDJSON and replay reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fpv-log-"));
  try {
    const log = createMatchLog("room", dir, { now: () => 1000 });
    log.write({ type: "a", n: 1 });
    log.write({ type: "b", n: 2 });
    await log.close();

    const text = await readFile(log.path, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 2);

    const events = [];
    for await (const event of replayEvents(log.path)) events.push(event);
    assert.deepEqual(events, [
      { t: 1000, type: "a", n: 1 },
      { t: 1000, type: "b", n: 2 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachMatchLog records room events and closes the file when the room empties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fpv-log-"));
  try {
    const room = new Room({ id: "lab", name: "Lab" });
    const attached = attachMatchLog(room, dir);
    const player = room.join("Ann");
    room.chat(player.id, "hi");
    room.leave(player.id);
    await attached.close();

    const { readdir } = await import("node:fs/promises");
    const [file] = await readdir(dir);
    assert.ok(file);
    const types: string[] = [];
    for await (const event of replayEvents(join(dir, file)))
      types.push(event.type);
    assert.deepEqual(types, ["join", "chat", "leave"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replayEvents reports the offending line of a corrupt log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fpv-log-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "bad.ndjson");
    await writeFile(path, '{"type":"join"}\nnot json\n');
    await assert.rejects(
      async () => {
        for await (const event of replayEvents(path)) assert.ok(event);
      },
      (error) => error instanceof ReplayParseError && error.line === 2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
