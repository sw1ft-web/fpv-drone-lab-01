/**
 * Load test: starts the real server as a CHILD PROCESS and connects N headless
 * WebSocket clients (this process) that fly scripted paths over the binary codec.
 * For every N it records the server's tick time p99, event-loop utilization, RSS
 * and bytes/s from /api/stats, and finds the N where the tick exceeds the 33 ms budget.
 *
 *   node scripts/loadtest.ts --steps 8,32,64,128 --seconds 12 --out docs/lab-07 [--label before]
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { z } from "zod";
import {
  STEPS_PER_TICK,
  TICK_MS,
  asSeq,
  binaryCodec,
} from "../shared/src/index.ts";
import { lineChartSvg } from "./lib/svg-chart.ts";
import { pilot } from "./lib/netsim.ts";

const { values } = parseArgs({
  options: {
    steps: { type: "string", default: "8,32,64,128" },
    seconds: { type: "string", default: "12" },
    out: { type: "string", default: "docs/lab-07" },
    label: { type: "string", default: "baseline" },
    port: { type: "string", default: "4310" },
    "node-args": { type: "string", default: "" },
    "players-per-room": { type: "string", default: "8" },
  },
});
const STEPS = values.steps.split(",").map(Number);
const SECONDS = Number(values.seconds);
const PORT = Number(values.port);
const PER_ROOM = Number(values["players-per-room"]);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BUDGET_MS = 1000 / 30;

const Stats = z.object({
  rssBytes: z.number(),
  eventLoopUtilization: z.number(),
  eventLoopDelayP99Ms: z.number(),
  bytesOut: z.number(),
  bytesIn: z.number(),
  snapshotsSent: z.number(),
  players: z.number(),
  tick: z.object({
    durationP50Ms: z.number(),
    durationP99Ms: z.number(),
    durationMaxMs: z.number(),
    latenessP99Ms: z.number(),
    skippedTicks: z.number(),
  }),
});

async function startServer(): Promise<{
  child: ChildProcess;
  stop(): Promise<void>;
}> {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-load-"));
  const extra = values["node-args"].split(" ").filter(Boolean);
  const child = spawn(process.execPath, [...extra, "server/src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      MAX_ROOMS: "200",
      MAX_PLAYERS_PER_ROOM: String(PER_ROOM),
      RATE_CAPACITY: "1000",
      RATE_REFILL_PER_SEC: "1000",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/health`)).ok) break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return {
    child,
    async stop() {
      const closed = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      child.kill("SIGINT"); // lets --cpu-prof flush its profile
      await closed;
    },
  };
}

async function createRooms(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `load-${i}`, maxPlayers: PER_ROOM }),
    });
    const body = z.object({ id: z.string() }).parse(await response.json());
    ids.push(body.id);
  }
  return ids;
}

interface Bot {
  socket: WebSocket;
  timer: NodeJS.Timeout | null;
}

function connectBot(roomId: string, index: number): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const bot: Bot = { socket, timer: null };
    const next = pilot(1000 + index);
    let seq = 0;
    socket.once("error", reject);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "join",
          roomId,
          name: `bot${index}`,
          codec: "binary",
        }),
      );
    });
    socket.on("message", (_data, isBinary) => {
      if (isBinary) return; // snapshots are only counted by the server
      // The first text message is the welcome: start flying.
      if (bot.timer) return;
      bot.timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const inputs = [];
        for (let step = 0; step < STEPS_PER_TICK; step += 1) {
          seq += 1;
          inputs.push({ seq: asSeq(seq), bits: next() });
        }
        socket.send(binaryCodec.encodeInput({ inputs }));
      }, TICK_MS);
      resolve(bot);
    });
  });
}

const percentile = (list: number[], q: number): number => {
  const sorted = [...list].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  );
};

async function runStep(players: number) {
  const server = await startServer();
  try {
    const rooms = await createRooms(Math.ceil(players / PER_ROOM));
    const bots: Bot[] = [];
    for (let i = 0; i < players; i += 1) {
      const room = rooms[Math.floor(i / PER_ROOM)];
      if (!room) throw new Error("not enough rooms");
      bots.push(await connectBot(room, i));
    }
    await new Promise((done) => setTimeout(done, 2000)); // warm-up (JIT)
    await fetch(`${ORIGIN}/api/stats`); // resets the utilization interval
    const before = Stats.parse(
      await (await fetch(`${ORIGIN}/api/stats`)).json(),
    );
    const samples: number[] = [];
    const startedAt = performance.now();
    while (performance.now() - startedAt < SECONDS * 1000) {
      await new Promise((done) => setTimeout(done, 500));
      const now = Stats.parse(
        await (await fetch(`${ORIGIN}/api/stats`)).json(),
      );
      samples.push(now.tick.durationP99Ms);
    }
    const elapsedSec = (performance.now() - startedAt) / 1000;
    const after = Stats.parse(
      await (await fetch(`${ORIGIN}/api/stats`)).json(),
    );
    for (const bot of bots) {
      if (bot.timer) clearInterval(bot.timer);
      bot.socket.close();
    }
    return {
      players,
      rooms: rooms.length,
      tickP50Ms: after.tick.durationP50Ms,
      tickP99Ms: after.tick.durationP99Ms,
      tickMaxMs: after.tick.durationMaxMs,
      latenessP99Ms: after.tick.latenessP99Ms,
      skippedTicks: after.tick.skippedTicks,
      eventLoopUtilization: after.eventLoopUtilization,
      eventLoopDelayP99Ms: after.eventLoopDelayP99Ms,
      rssMB: after.rssBytes / 1024 / 1024,
      kbPerSecOut: (after.bytesOut - before.bytesOut) / elapsedSec / 1024,
      kbPerSecIn: (after.bytesIn - before.bytesIn) / elapsedSec / 1024,
      snapshotsPerSec:
        (after.snapshotsSent - before.snapshotsSent) / elapsedSec,
      tickP99Series: samples,
      medianOfP99Ms: percentile(samples, 0.5),
    };
  } finally {
    await server.stop();
  }
}

const results = [];
for (const players of STEPS) {
  const result = await runStep(players);
  results.push(result);
  console.log(
    `N=${String(players).padStart(4)} rooms=${result.rooms} tick p50=${result.tickP50Ms.toFixed(2)}ms p99=${result.tickP99Ms.toFixed(2)}ms max=${result.tickMaxMs.toFixed(1)}ms ELU=${(result.eventLoopUtilization * 100).toFixed(0)}% RSS=${result.rssMB.toFixed(0)}MB out=${result.kbPerSecOut.toFixed(0)}KB/s snaps/s=${result.snapshotsPerSec.toFixed(0)} skipped=${result.skippedTicks}`,
  );
}

const over = results.find((r) => r.tickP99Ms > BUDGET_MS);
const capacity = over
  ? `tick p99 exceeds the ${BUDGET_MS.toFixed(1)} ms budget at N=${over.players}`
  : `tick p99 stayed under ${BUDGET_MS.toFixed(1)} ms up to N=${results.at(-1)?.players ?? 0}`;
console.log(capacity);

await mkdir(values.out, { recursive: true });
const base = join(values.out, `loadtest-${values.label}`);
await writeFile(
  `${base}.json`,
  `${JSON.stringify({ environment: { node: process.version, cpus: (await import("node:os")).cpus().length, platform: process.platform }, seconds: SECONDS, perRoom: PER_ROOM, budgetMs: BUDGET_MS, capacity, results: results.map(({ tickP99Series: _s, ...rest }) => rest) }, null, 2)}\n`,
);
await writeFile(
  `${base}.svg`,
  lineChartSvg({
    title: `Server tick time vs players (${values.label})`,
    xLabel: "players",
    yLabel: "tick time, ms",
    series: [
      {
        name: "p50",
        points: results.map((r) => [r.players, r.tickP50Ms] as const),
      },
      {
        name: "p99",
        points: results.map((r) => [r.players, r.tickP99Ms] as const),
      },
      {
        name: "budget 33 ms",
        color: "#dc2626",
        points: results.map((r) => [r.players, BUDGET_MS] as const),
      },
    ],
  }),
);
