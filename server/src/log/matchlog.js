import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Object-mode Transform: one event object in, one NDJSON line out. */
export function createNdjsonTransform() {
  return new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error) {
        callback(error);
      }
    },
  });
}

/**
 * Writes room events to `<dir>/<roomId>-<timestamp>.ndjson` through
 * `pipeline(transform, fileStream)` so that errors and backpressure are
 * handled by the stream machinery. Resolves `finished` when the file is closed.
 */
export function createMatchLog(
  roomId,
  dir,
  { now = Date.now, onError = () => {} } = {},
) {
  const startedAt = now();
  const id = `${roomId}-${startedAt}`;
  const path = join(dir, `${id}.ndjson`);
  const transform = createNdjsonTransform();
  let closed = false;

  const finished = mkdir(dir, { recursive: true })
    .then(() => pipeline(transform, createWriteStream(path)))
    .catch((error) => {
      closed = true;
      onError(error);
    });

  return {
    id,
    path,
    write(event) {
      if (closed || transform.writableEnded) return false;
      return transform.write({ t: now(), ...event });
    },
    async close() {
      if (!transform.writableEnded) transform.end();
      await finished;
      closed = true;
    },
    finished,
  };
}

/**
 * Subscribes to a room and logs its events. A new file is started whenever
 * the room goes from empty to occupied. Returns `{ close() }`.
 */
export function attachMatchLog(room, dir, { now = Date.now, onError } = {}) {
  let log = null;
  const pending = new Set();

  const ensure = () => {
    log ??= createMatchLog(room.id, dir, { now, onError });
    return log;
  };
  const endCurrent = () => {
    if (!log) return;
    const closing = log.close();
    pending.add(closing);
    closing.finally(() => pending.delete(closing));
    log = null;
  };

  const onJoin = ({ player }) => ensure().write({ type: "join", player });
  const onLeave = ({ player }) => log?.write({ type: "leave", player });
  const onChat = ({ from, playerId, text }) =>
    log?.write({ type: "chat", from, playerId, text });

  room.on("join", onJoin);
  room.on("leave", onLeave);
  room.on("chat", onChat);
  room.on("empty", endCurrent);

  return {
    async close() {
      room.off("join", onJoin);
      room.off("leave", onLeave);
      room.off("chat", onChat);
      room.off("empty", endCurrent);
      endCurrent();
      await Promise.all(pending);
    },
  };
}
