import { defineConfig } from "vitest/config";

/**
 * One Vitest run for the whole repo. Each package is a "project" so it keeps its
 * own include pattern, and `npm test -w <pkg>` still works on its own.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./shared",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "server",
          root: "./server",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
      {
        test: {
          name: "client",
          root: "./client",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "netcode",
          root: "./scripts",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts"],
      exclude: ["shared/src/**/index.ts"],
      reporter: ["text", "text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
