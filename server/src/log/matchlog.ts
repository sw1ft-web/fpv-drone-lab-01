import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Player, Room } from "../rooms.ts";

/** What callers hand to `write`: any object with a `type`; the log adds the timestamp. */
export interface LogEntry {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface MatchLogOptions {
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface MatchLog {
  readonly id: string;
  readonly path: string;
  readonly finished: Promise<void>;
  write(event: LogEntry): boolean;
  close(): Promise<void>;
}

/** Object-mode Transform: one event object in, one NDJSON line out. */
export function createNdjsonTransform(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
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
  roomId: string,
  dir: string,
  { now = Date.now, onError = () => {} }: MatchLogOptions = {},
): MatchLog {
  const startedAt = now();
  const id = `${roomId}-${startedAt}`;
  const path = join(dir, `${id}.ndjson`);
  const transform = createNdjsonTransform();
  let closed = false;

  const finished = mkdir(dir, { recursive: true })
    .then(() => pipeline(transform, createWriteStream(path)))
    .catch((error: unknown) => {
      closed = true;
      onError(error);
    });

  return {
    id,
    path,
    write(event: LogEntry): boolean {
      if (closed || transform.writableEnded) return false;
      return transform.write({ t: now(), ...event });
    },
    async close(): Promise<void> {
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
export function attachMatchLog(
  room: Room,
  dir: string,
  { now = Date.now, onError }: MatchLogOptions = {},
): { close(): Promise<void> } {
  let log: MatchLog | null = null;
  const pending = new Set<Promise<void>>();

  const ensure = () => {
    log ??= createMatchLog(room.id, dir, { now, onError });
    return log;
  };
  const endCurrent = () => {
    if (!log) return;
    const closing = log.close();
    pending.add(closing);
    void closing.finally(() => pending.delete(closing));
    log = null;
  };

  const onJoin = ({ player }: { player: Player }): void => {
    ensure().write({ type: "join", player });
  };
  const onLeave = ({ player }: { player: Player }): void => {
    log?.write({ type: "leave", player });
  };
  const onChat = ({
    from,
    playerId,
    text,
  }: {
    from: string;
    playerId: string;
    text: string;
  }): void => {
    log?.write({ type: "chat", from, playerId, text });
  };

  room.on("join", onJoin);
  room.on("leave", onLeave);
  room.on("chat", onChat);
  room.on("empty", endCurrent);

  return {
    async close(): Promise<void> {
      room.off("join", onJoin);
      room.off("leave", onLeave);
      room.off("chat", onChat);
      room.off("empty", endCurrent);
      endCurrent();
      await Promise.all(pending);
    },
  };
}
