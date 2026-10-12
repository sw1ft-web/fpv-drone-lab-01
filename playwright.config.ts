import { defineConfig } from "@playwright/test";

const PORT = 4173;

/**
 * End-to-end: the real server serves the real built client, two real browser
 * contexts play against each other. `PW_CHROMIUM` lets a machine without the
 * Playwright-managed browser point at an existing Chromium.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(process.env["PW_CHROMIUM"]
        ? { executablePath: process.env["PW_CHROMIUM"] }
        : {}),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "npm run build && node server/src/index.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: ".tmp/e2e-logs",
    },
  },
});
