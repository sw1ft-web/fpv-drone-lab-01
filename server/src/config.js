import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {
  constructor(problems) {
    super(
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const int = (fallback, min, max) => (raw, name, problems) => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(
      `${name} must be an integer in [${min}, ${max}], got "${raw}"`,
    );
    return fallback;
  }
  return value;
};

const bool = (fallback) => (raw, name, problems) => {
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  problems.push(`${name} must be a boolean (true/false), got "${raw}"`);
  return fallback;
};

const path = (fallback) => (raw) =>
  resolve(raw === undefined || raw === "" ? fallback : raw);

const defaultClientDir = fileURLToPath(
  new URL("../../client/dist", import.meta.url),
);

const SCHEMA = {
  PORT: int(3000, 0, 65535),
  HOST: (raw) => (raw === undefined || raw === "" ? "0.0.0.0" : raw),
  LOG_DIR: path("./logs"),
  CLIENT_DIR: path(defaultClientDir),
  DEBUG_ROUTES: bool(true),
  MAX_ROOMS: int(20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: int(8, 1, 64),
  MAX_BODY_BYTES: int(4096, 64, 1_048_576),
  MAX_PAYLOAD_BYTES: int(2048, 64, 1_048_576),
  JOIN_TIMEOUT_MS: int(5000, 10, 120_000),
  HEARTBEAT_MS: int(15_000, 10, 120_000),
  RATE_CAPACITY: int(90, 1, 10_000),
  RATE_REFILL_PER_SEC: int(45, 1, 10_000),
  MAX_BUFFERED_BYTES: int(65_536, 1024, 64 * 1024 * 1024),
  SHUTDOWN_TIMEOUT_MS: int(10_000, 100, 120_000),
};

/**
 * Reads settings from `env` (process.env by default), applies defaults and
 * validates every value. All problems are reported together.
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const config = {};
  for (const [name, parse] of Object.entries(SCHEMA)) {
    config[name] = parse(env[name], name, problems);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
