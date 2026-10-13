import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LOG_LEVELS } from "./logger.ts";

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const defaultClientDir = fileURLToPath(
  new URL("../../client/dist", import.meta.url),
);

/** Environment variables are strings (or missing/empty): treat "" as "not set" so defaults apply. */
const unset = (raw: unknown): unknown => (raw === "" ? undefined : raw);

const int = (fallback: number, min: number, max: number) =>
  z.preprocess(
    unset,
    z.coerce
      .number({ error: "must be an integer" })
      .int({ error: "must be an integer" })
      .min(min, { error: `must be an integer in [${min}, ${max}]` })
      .max(max, { error: `must be an integer in [${min}, ${max}]` })
      .default(fallback),
  );

const bool = (fallback: boolean) =>
  z.preprocess(
    unset,
    z
      .string()
      .transform((raw) => raw.toLowerCase())
      .pipe(
        z.enum(["1", "true", "yes", "0", "false", "no"], {
          error: "must be a boolean (true/false)",
        }),
      )
      .transform((raw) => ["1", "true", "yes"].includes(raw))
      .default(fallback),
  );

const path = (fallback: string) =>
  z.preprocess(
    unset,
    z
      .string()
      .default(fallback)
      .transform((raw) => resolve(raw)),
  );

/** The single description of the server's settings: names, defaults and limits. */
const csv = (fallback: string) =>
  z.preprocess(
    unset,
    z
      .string()
      .default(fallback)
      .transform((raw) =>
        raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      ),
  );

export const ServerConfigSchema = z.object({
  NODE_ENV: z.preprocess(
    unset,
    z.enum(["development", "production", "test"]).default("development"),
  ),
  LOG_LEVEL: z.preprocess(unset, z.enum(LOG_LEVELS).default("info")),
  /**
   * Browser origins allowed to open a WebSocket (comma-separated, e.g.
   * "https://fpv.example.com"). Empty = same-origin only (the Origin host must
   * equal the Host header). Requests with no Origin header (non-browser clients) are allowed.
   */
  ALLOWED_ORIGINS: csv(""),
  /** Open WebSocket connections allowed per client IP. */
  MAX_CONNECTIONS_PER_IP: int(20, 1, 100_000),
  /** Trust X-Forwarded-For (only behind a proxy you control: it is client-controlled otherwise). */
  TRUST_PROXY: bool(false),
  /** Stamped into /health and /metrics; the Docker build sets it from the git commit. */
  /** If set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.preprocess(unset, z.string().optional()),
  GIT_SHA: z.preprocess(unset, z.string().default("dev")),
  PORT: int(3000, 0, 65535),
  HOST: z.preprocess(unset, z.string().default("0.0.0.0")),
  LOG_DIR: path("./logs"),
  CLIENT_DIR: path(defaultClientDir),
  DEBUG_ROUTES: bool(true),
  MAX_ROOMS: int(20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: int(8, 1, 64),
  MAX_BODY_BYTES: int(4096, 64, 1_048_576),
  /** Busy-wait window before each tick deadline (0 = pure timers). See docs/lab-07.md. */
  TICK_SPIN_MS: z.preprocess(
    unset,
    z.coerce.number().min(0).max(10).default(2),
  ),
  MAX_PAYLOAD_BYTES: int(2048, 64, 1_048_576),
  JOIN_TIMEOUT_MS: int(5000, 10, 120_000),
  HEARTBEAT_MS: int(15_000, 10, 120_000),
  RATE_CAPACITY: int(90, 1, 10_000),
  RATE_REFILL_PER_SEC: int(45, 1, 10_000),
  MAX_BUFFERED_BYTES: int(65_536, 1024, 64 * 1024 * 1024),
  SHUTDOWN_TIMEOUT_MS: int(10_000, 100, 120_000),
});

/** Validated, frozen settings; every field has the type its schema says. */
export type ServerConfig = Readonly<z.output<typeof ServerConfigSchema>>;

/**
 * Reads settings from `env` (process.env by default), applies defaults and
 * validates every value. All problems are reported together.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const parsed = ServerConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) =>
          `${issue.path.join(".")} ${issue.message}, got "${String(env[String(issue.path[0])])}"`,
      ),
    );
  }
  return Object.freeze(parsed.data);
}
