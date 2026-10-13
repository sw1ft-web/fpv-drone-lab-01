import { pino } from "pino";

/** The structured-logging interface the server needs; pino and test doubles both fit. */
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * One JSON object per line on stdout (pino). Field names: `level` (numeric, pino
 * convention), `time`, `msg`, plus the fields of each call (`conn`, `roomId`,
 * `playerId`, `reason`, ...). Anything that could carry a secret is redacted.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  return pino({
    level,
    base: { service: "fpv-server" },
    // pino's `level` is a number by default; a label is friendlier in `docker logs | jq`.
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
    redact: {
      paths: [
        "*.authorization",
        "*.cookie",
        "*.token",
        "*.password",
        "authorization",
        "cookie",
        "token",
        "password",
        "dsn",
      ],
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const consoleLogger: Logger = createLogger(
  LOG_LEVELS.find((level) => level === process.env["LOG_LEVEL"]) ?? "info",
);

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
