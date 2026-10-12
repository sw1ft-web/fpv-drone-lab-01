// Event-loop experiment: one client chats at 20 msg/s while /api/slow?block=300
// blocks the server thread. Measures delivery latency seen by a second client.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../docs/lab-04");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logDir = await mkdtemp(join(tmpdir(), "fpv-block-"));
const child = spawn(process.execPath, [join(here, "../src/index.js")], {
  env: {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: logDir,
    RATE_CAPACITY: "200",
    RATE_REFILL_PER_SEC: "100",
    DEBUG_ROUTES: "true",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((resolve) => {
  child.stdout.on("data", (chunk) => {
    const line = chunk
      .toString()
      .split("\n")
      .find((entry) => entry.includes("server listening"));
    if (line) resolve(JSON.parse(line).port);
  });
});

function open(name) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve) => {
    socket.on("open", () => {
      socket.send(
        JSON.stringify({ v: 0, type: "join", roomId: "kyiv-alpha", name }),
      );
    });
    socket.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "welcome") resolve(socket);
    });
  });
}

async function run(withBlock) {
  const sender = await open("Ann");
  const receiver = await open("Bob");
  const latencies = [];
  receiver.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "chat") return;
    latencies.push(performance.now() - Number(message.text));
  });

  const durationMs = 4000;
  const started = performance.now();
  let blockResult = null;
  const timer = setInterval(() => {
    sender.send(
      JSON.stringify({ v: 0, type: "chat", text: String(performance.now()) }),
    );
  }, 50);
  if (withBlock) {
    await sleep(1500);
    const response = await fetch(`http://127.0.0.1:${port}/api/slow?block=300`);
    blockResult = await response.json();
  }
  await sleep(Math.max(0, durationMs - (performance.now() - started)));
  clearInterval(timer);
  await sleep(200);
  sender.close();
  receiver.close();
  await sleep(100);

  latencies.sort((a, b) => a - b);
  const pick = (q) =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  return {
    messages: latencies.length,
    p50Ms: +pick(0.5).toFixed(1),
    p99Ms: +pick(0.99).toFixed(1),
    maxMs: +latencies.at(-1).toFixed(1),
    blockResult,
  };
}

const baseline = await run(false);
const blocked = await run(true);
child.kill("SIGTERM");
await rm(logDir, { recursive: true, force: true });

const result = { baseline, withBlock300ms: blocked };
console.log(JSON.stringify(result, null, 2));
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, "blocking-demo.json"),
  JSON.stringify(result, null, 2) + "\n",
);
