import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

export class ReplayParseError extends Error {
  constructor(line, cause) {
    super(`invalid NDJSON at line ${line}`, { cause });
    this.name = "ReplayParseError";
    this.line = line;
  }
}

/** Async generator over the events of a saved NDJSON log. */
export async function* replayEvents(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line);
      } catch (error) {
        throw new ReplayParseError(lineNumber, error);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** The same events as an object-mode Readable (async iteration + pipeline friendly). */
export function createReplayReadable(path) {
  return Readable.from(replayEvents(path), { objectMode: true });
}
