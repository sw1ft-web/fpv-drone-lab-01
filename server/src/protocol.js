import {
  CHAT_MAX,
  CLOSE,
  CODEC_NAMES,
  FATAL_CLOSE_CODES,
  NAME_MAX,
  PROTOCOL_VERSION,
} from "@fpv/shared/protocol";
import {
  CodecError,
  FRAME_TYPE,
  binaryCodec,
  jsonCodec,
  peekFrameType,
} from "@fpv/shared/codec";

/**
 * Protocol v1: versioned JSON control messages `{ v: 1, type, ... }` plus game
 * messages (`input`), which travel as JSON text or as binary frames depending
 * on the codec the client chose in `join`.
 * Every message from a client is untrusted: it is validated here before it
 * reaches any room or match logic.
 */
export { CHAT_MAX, CLOSE, FATAL_CLOSE_CODES, NAME_MAX, PROTOCOL_VERSION };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const fail = (code, reason) => ({ ok: false, code, reason });
const ok = (message) => ({ ok: true, message });

export function isValidName(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= NAME_MAX &&
    !CONTROL_CHARS.test(value)
  );
}

export function isValidRoomId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * @param {string|Buffer|ArrayBuffer|Buffer[]} raw frame payload
 * @param {boolean} isBinary whether the frame was binary
 * @returns {{ok: true, message: object} | {ok: false, code: number, reason: string}}
 */
export function parseClientMessage(raw, isBinary = false) {
  if (isBinary) {
    try {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw;
      if (peekFrameType(bytes) !== FRAME_TYPE.INPUT)
        return fail(CLOSE.BAD_MESSAGE, "unexpected binary frame type");
      return ok({ type: "input", ...binaryCodec.decodeInput(bytes) });
    } catch (error) {
      if (error instanceof CodecError)
        return fail(CLOSE.BAD_MESSAGE, `bad input: ${error.message}`);
      throw error;
    }
  }

  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return fail(CLOSE.BAD_MESSAGE, "malformed JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return fail(CLOSE.BAD_MESSAGE, "message must be a JSON object");
  }
  if (data.v !== PROTOCOL_VERSION) {
    return fail(
      CLOSE.BAD_MESSAGE,
      `unsupported protocol version ${String(data.v)}`,
    );
  }

  switch (data.type) {
    case "join":
      if (!isValidRoomId(data.roomId))
        return fail(CLOSE.BAD_MESSAGE, "invalid roomId");
      if (!isValidName(data.name))
        return fail(CLOSE.BAD_MESSAGE, "invalid name");
      if (data.codec !== undefined && !CODEC_NAMES.includes(data.codec)) {
        return fail(CLOSE.BAD_MESSAGE, "invalid codec");
      }
      return ok({
        type: "join",
        roomId: data.roomId,
        name: data.name.trim(),
        codec: data.codec ?? "json",
      });
    case "input":
      try {
        return ok({ type: "input", ...jsonCodec.decodeInput(raw.toString()) });
      } catch (error) {
        if (error instanceof CodecError)
          return fail(CLOSE.BAD_MESSAGE, `bad input: ${error.message}`);
        throw error;
      }
    case "chat":
      if (
        typeof data.text !== "string" ||
        data.text.trim().length === 0 ||
        data.text.length > CHAT_MAX ||
        CONTROL_CHARS.test(data.text)
      ) {
        return fail(CLOSE.BAD_MESSAGE, "invalid chat text");
      }
      return ok({ type: "chat", text: data.text.trim() });
    case "leave":
      return ok({ type: "leave" });
    default:
      return fail(
        CLOSE.UNKNOWN_TYPE,
        `unknown message type ${JSON.stringify(data.type)}`,
      );
  }
}

export function encodeServerMessage(message) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

/** Server -> client message types (documented for the client dispatcher). */
export const SERVER_MESSAGE_TYPES = [
  "welcome",
  "roster",
  "chat",
  "error",
  "snapshot",
];
