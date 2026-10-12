import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

type Middlewares = {
  use(
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      next: () => void,
    ) => void,
  ): unknown;
};

const serverPort = process.env.SERVER_PORT ?? "3000";

/**
 * Dev/preview only: `?labDelay=<ms>` on an asset URL delays the response so
 * the Lab 03 progress bar and the sequential-vs-concurrent difference are
 * visible. The real game server ignores the query string.
 */
function labDelayPlugin(): Plugin {
  const install = (middlewares: Middlewares): void => {
    middlewares.use((req, _res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const delay = Math.min(
        1200,
        Math.max(0, Number(url.searchParams.get("labDelay")) || 0),
      );
      if (delay > 0) setTimeout(next, delay);
      else next();
    });
  };

  return {
    name: "lab-delay",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

const proxy = {
  "/api": `http://localhost:${serverPort}`,
  "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
};

export default defineConfig({
  plugins: [labDelayPlugin()],
  server: { proxy },
  preview: { proxy },
});
