/**
 * Wire-level constants shared by the client and the server.
 * Protocol v1 = the Lab 04 JSON control messages (join / chat / leave /
 * welcome / roster / error) plus the game messages (input / snapshot).
 */
export const PROTOCOL_VERSION = 1;

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

/** After these close codes the client must not reconnect automatically. */
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

/** A client keeps sending the last unacknowledged inputs so a lost message is covered by the next. */
export const MAX_INPUTS_PER_MESSAGE = 16;

export const CODEC_NAMES = ["json", "binary"];
