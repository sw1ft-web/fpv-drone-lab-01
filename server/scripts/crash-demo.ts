// Shows why an unhandled 'error' event / promise rejection kills a Node process,
// and the fix. Output is saved to docs/lab-04/crash-excerpt.txt.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const cases = [
  {
    title: "1. EventEmitter 'error' without a listener",
    code: `
      import { EventEmitter } from "node:events";
      const socket = new EventEmitter();
      setTimeout(() => console.log("never printed: the process is already dead"), 100);
      socket.emit("error", new Error("ECONNRESET: peer reset the connection"));
    `,
  },
  {
    title: "2. Unhandled promise rejection in an async handler",
    code: `
      async function handler() { throw new Error("room lookup failed"); }
      handler(); // not awaited, no .catch()
      setTimeout(() => console.log("never printed"), 100);
    `,
  },
  {
    title: "3. FIX: error listener + .catch() -> the process keeps running",
    code: `
      import { EventEmitter } from "node:events";
      const socket = new EventEmitter();
      socket.on("error", (error) => console.log("handled:", error.message));
      socket.emit("error", new Error("ECONNRESET: peer reset the connection"));
      async function handler() { throw new Error("room lookup failed"); }
      handler().catch((error) => console.log("handled:", error.message));
      setTimeout(() => console.log("still alive after 100 ms"), 100);
    `,
  },
];

const lines = [];
for (const { title, code } of cases) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  const output = `${run.stdout}${run.stderr}`
    .replaceAll(pathToFileURL(process.cwd()).href, "<project>")
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        !line.includes("node:internal") &&
        !line.includes("Node.js v") &&
        !line.includes("^"),
    )
    .slice(0, 8)
    .join("\n");
  lines.push(`### ${title}`, `exit code: ${run.status}`, output, "");
}

const text = lines.join("\n");
console.log(text);
await mkdir(join(here, "../../docs/lab-04"), { recursive: true });
await writeFile(join(here, "../../docs/lab-04/crash-excerpt.txt"), text);
