import type { RawData } from "ws";
import {
  CHAT_MAX,
  CLOSE,
  FATAL_CLOSE_CODES,
  NAME_MAX,
  PROTOCOL_VERSION,
  parseClientMessage as parseClientJson,
} from "@fpv/shared/protocol";
import type { ClientMessage, ServerMessageInput } from "@fpv/shared/protocol";
import {
  CodecError,
  FRAME_TYPE,
  binaryCodec,
  peekFrameType,
} from "@fpv/shared/codec";

/**
 * Protocol v1: versioned JSON control messages `{ v: 1, type, ... }` plus game
 * messages (`input`), which travel as JSON text or as binary frames depending
 * on the codec the client chose in `join`.
 *
 * Every frame from a client is untrusted. The schemas live in
 * `@fpv/shared/protocol` (one definition for both sides); this module only
 * turns a raw WebSocket frame into either a typed `ClientMessage` or the close
 * code the connection must be dropped with. Nothing here throws on bad input.
 */
export { CHAT_MAX, CLOSE, FATAL_CLOSE_CODES, NAME_MAX, PROTOCOL_VERSION };

export type ParsedFrame =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: number; readonly reason: string };

const fail = (code: number, reason: string): ParsedFrame => ({
  ok: false,
  code,
  reason,
});

const toBuffer = (raw: RawData): Buffer =>
  Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : raw;

/** The UTF-8 text of whatever `ws` handed us. */
export const rawToText = (raw: RawData): string =>
  toBuffer(raw).toString("utf8");

/** Length in bytes of whatever `ws` handed us. */
export function frameBytes(raw: RawData): number {
  return toBuffer(raw).byteLength;
}

export function parseClientMessage(
  raw: RawData,
  isBinary = false,
): ParsedFrame {
  const bytes = toBuffer(raw);

  if (isBinary) {
    try {
      if (peekFrameType(bytes) !== FRAME_TYPE.INPUT)
        return fail(CLOSE.BAD_MESSAGE, "unexpected binary frame type");
      const { inputs } = binaryCodec.decodeInput(bytes);
      return {
        ok: true,
        message: { v: PROTOCOL_VERSION, type: "input", inputs },
      };
    } catch (error) {
      if (error instanceof CodecError)
        return fail(CLOSE.BAD_MESSAGE, `bad input: ${error.message}`);
      throw error;
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail(CLOSE.BAD_MESSAGE, "malformed JSON");
  }

  const parsed = parseClientJson(data);
  if (parsed.ok) return { ok: true, message: parsed.value };
  const reason = parsed.detail ?? parsed.error;
  switch (parsed.error) {
    case "unknown_type":
      return fail(CLOSE.UNKNOWN_TYPE, reason);
    case "bad_message":
      return fail(CLOSE.BAD_MESSAGE, reason);
    default:
      return neverError(parsed.error);
  }
}

function neverError(value: never): never {
  throw new Error(`unhandled parse error ${String(value)}`);
}

export function encodeServerMessage(message: ServerMessageInput): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}
