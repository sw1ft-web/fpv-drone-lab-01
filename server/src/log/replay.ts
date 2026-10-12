import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

export class ReplayParseError extends Error {
  readonly line: number;

  constructor(line: number, cause: unknown) {
    super(`invalid NDJSON at line ${line}`, { cause });
    this.name = "ReplayParseError";
    this.line = line;
  }
}

/** One line of a match log: a timestamp, a type and whatever fields that event type carries. */
export interface LoggedEvent {
  readonly t: number;
  readonly type: string;
  readonly [field: string]: unknown;
}

const isLoggedEvent = (value: unknown): value is LoggedEvent =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/** Async generator over the events of a saved NDJSON log. */
export async function* replayEvents(
  path: string,
): AsyncGenerator<LoggedEvent, void, undefined> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new ReplayParseError(lineNumber, error);
      }
      if (!isLoggedEvent(event))
        throw new ReplayParseError(
          lineNumber,
          new Error("not an event object"),
        );
      yield event;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** The same events as an object-mode Readable (async iteration + pipeline friendly). */
export function createReplayReadable(path: string): Readable {
  return Readable.from(replayEvents(path), { objectMode: true });
}
