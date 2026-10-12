import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

test("applies defaults", () => {
  const config = loadConfig({});
  assert.equal(config.PORT, 3000);
  assert.equal(config.MAX_PLAYERS_PER_ROOM, 8);
  assert.equal(config.DEBUG_ROUTES, true);
});

test("reads and coerces values from the environment", () => {
  const config = loadConfig({
    PORT: "8080",
    DEBUG_ROUTES: "false",
    HEARTBEAT_MS: "50",
  });
  assert.equal(config.PORT, 8080);
  assert.equal(config.DEBUG_ROUTES, false);
  assert.equal(config.HEARTBEAT_MS, 50);
});

test("reports all problems at once", () => {
  assert.throws(
    () => loadConfig({ PORT: "abc", MAX_ROOMS: "-1", DEBUG_ROUTES: "maybe" }),
    (error) => error instanceof ConfigError && error.problems.length === 3,
  );
});
