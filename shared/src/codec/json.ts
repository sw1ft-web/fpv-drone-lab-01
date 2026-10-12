import { PROTOCOL_VERSION } from "../protocol/constants.ts";
import { InputSchema, SnapshotMessageSchema } from "../protocol/messages.ts";
import type { InputEntry, Snapshot } from "../types.ts";
import { CodecError } from "./errors.ts";

/** JSON text, or the bytes of JSON text (what a WebSocket delivers for a text frame in some runtimes). */
export type JsonData = string | ArrayBuffer | Uint8Array;

function parse(data: JsonData): unknown {
  try {
    return JSON.parse(
      typeof data === "string" ? data : new TextDecoder().decode(data),
    );
  } catch {
    throw new CodecError("malformed JSON");
  }
}

/** Runs a zod schema and converts a failure into the codec's own error type. */
function check<T>(
  result: { success: true; data: T } | { success: false; error: Error },
  what: string,
): T {
  if (result.success) return result.data;
  throw new CodecError(`${what}: ${result.error.message}`);
}

export interface DecodedInput {
  readonly type: "input";
  readonly inputs: InputEntry[];
}

export function encodeInput({
  inputs,
}: {
  readonly inputs: readonly InputEntry[];
}): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "input", inputs });
}

export function decodeInput(data: JsonData): DecodedInput {
  const message = check(InputSchema.safeParse(parse(data)), "invalid input");
  return { type: "input", inputs: message.inputs };
}

export function encodeSnapshot({ tick, ack, entities }: Snapshot): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "snapshot",
    tick,
    ack,
    entities,
  });
}

export interface DecodedSnapshot extends Snapshot {
  readonly type: "snapshot";
}

export function decodeSnapshot(data: JsonData): DecodedSnapshot {
  const message = check(
    SnapshotMessageSchema.safeParse(parse(data)),
    "invalid snapshot",
  );
  return {
    type: "snapshot",
    tick: message.tick,
    ack: message.ack,
    entities: message.entities,
  };
}
