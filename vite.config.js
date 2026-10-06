import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const projectDir = dirname(fileURLToPath(import.meta.url));
const roomsJson = readFileSync(resolve(projectDir, "public/api/rooms.json"), "utf8");
const brokenJson = readFileSync(resolve(projectDir, "public/api/bad-json"), "utf8");

function lab03ApiPlugin() {
  const install = (middlewares) => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/api/rooms") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(roomsJson);
        return;
      }

      if (url.pathname === "/api/bad-json") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(brokenJson);
        return;
      }

      if (url.pathname === "/api/slow") {
        const delay = Math.min(
          5000,
          Math.max(0, Number(url.searchParams.get("delay")) || 1800),
        );
        setTimeout(() => {
          if (res.writableEnded) return;
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, delay }));
        }, delay);
        return;
      }

      // Optional per-asset dev delay makes Promise.all progress visible.
      const assetDelay = Math.min(
        1200,
        Math.max(0, Number(url.searchParams.get("labDelay")) || 0),
      );
      if (assetDelay > 0) setTimeout(next, assetDelay);
      else next();
    });
  };

  return {
    name: "lab03-api-delay",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [lab03ApiPlugin()],
});
