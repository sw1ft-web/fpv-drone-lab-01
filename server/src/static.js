import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Maps a request pathname to a file inside `root`, or null when the path
 * escapes the root (path traversal), contains NUL bytes or is malformed.
 */
export function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rootPath = resolve(root);
  const target = resolve(join(rootPath, decoded));
  if (target !== rootPath && !target.startsWith(rootPath + sep)) return null;
  return target;
}

export async function serveStatic(req, res, { root, pathname }) {
  let file = resolveStaticPath(root, pathname);
  if (file === null) {
    res
      .writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Forbidden");
    return;
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    res
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Not found");
    return;
  }

  const type =
    MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": type.startsWith("text/html")
      ? "no-cache"
      : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(file), res);
  } catch {
    // Client went away mid-transfer: pipeline already destroyed both streams.
  }
}
