/**
 * Protocol v0: versioned JSON messages `{ v: 0, type, ... }`.
 * Every message from a client is untrusted: it is validated here before it
 * reaches any room logic.
 */
export const PROTOCOL_VERSION = 0;

export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TOO_BIG: 1009,
  BAD_MESSAGE: 4000,
  UNKNOWN_TYPE: 4001,
  JOIN_TIMEOUT: 4002,
  RATE_LIMIT: 4003,
  ROOM_UNAVAILABLE: 4004,
  SLOW_CLIENT: 4005,
});

/** Close codes after which the client must not reconnect automatically. */
export const FATAL_CLOSE_CODES = new Set([
  CLOSE.TOO_BIG,
  CLOSE.BAD_MESSAGE,
  CLOSE.UNKNOWN_TYPE,
  CLOSE.JOIN_TIMEOUT,
  CLOSE.RATE_LIMIT,
  CLOSE.ROOM_UNAVAILABLE,
  CLOSE.SLOW_CLIENT,
]);

export const NAME_MAX = 18;
export const CHAT_MAX = 200;
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
  if (isBinary)
    return fail(CLOSE.BAD_MESSAGE, "binary frames are not supported");

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
      return ok({ type: "join", roomId: data.roomId, name: data.name.trim() });
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
export const SERVER_MESSAGE_TYPES = ["welcome", "roster", "chat", "error"];
