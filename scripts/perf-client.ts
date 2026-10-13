/**
 * Browser performance harness: real server (child process) + real Chromium
 * (Playwright) + N server-side bots, driven through the Chrome DevTools Protocol.
 *
 * Records, for a fixed time window of heavy play:
 *   - frame-to-frame time and the instrumented spans (src/perf.ts): p50/p95/p99
 *   - GC events from a CDP trace (minor/major count, total pause)
 *   - top self-time functions (CPU profile) and top allocators (sampling heap profile)
 * and writes JSON, a markdown table and a flame-graph SVG built from the CPU profile.
 *
 *   PERF_BUILD=1 npm run build && node scripts/perf-client.ts --label before --bots 8 --seconds 30
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { topSelfTime } from "./cpuprofile-top.ts";
import { flameGraphSvg } from "./lib/flamegraph.ts";

declare global {
  interface Window {
    labPerf?: { reset(): void; report(): unknown };
  }
}

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "before" },
    bots: { type: "string", default: "8" },
    seconds: { type: "string", default: "30" },
    out: { type: "string", default: "docs/lab-07" },
    port: { type: "string", default: "4320" },
    /** Serve a different build (e.g. a worktree of an older commit) to compare against. */
    "client-dir": { type: "string", default: "" },
    /** "off": record only the GC trace + rAF frame times (profilers perturb what they measure). */
    profilers: { type: "string", default: "on" },
  },
});
const PORT = Number(values.port);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECONDS = Number(values.seconds);
const BOTS = Number(values.bots);
const label = values.label;
const PROFILERS = values.profilers !== "off";
const outDir = values.out;

const Spans = z.record(
  z.string(),
  z.object({
    count: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
    max: z.number(),
    totalMs: z.number(),
  }),
);

const HeapNode: z.ZodType<HeapNodeT> = z.lazy(() =>
  z.object({
    callFrame: z.object({
      functionName: z.string(),
      url: z.string(),
      lineNumber: z.number(),
    }),
    selfSize: z.number(),
    children: z.array(HeapNode),
  }),
);
interface HeapNodeT {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: HeapNodeT[];
}

const TraceEvent = z.object({
  name: z.string(),
  ph: z.string(),
  dur: z.number().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

async function main(): Promise<void> {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-perf-"));
  const server = spawn(process.execPath, ["server/src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      MAX_PLAYERS_PER_ROOM: "16",
      ...(values["client-dir"] ? { CLIENT_DIR: values["client-dir"] } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${ORIGIN}/health`)).ok) break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  const browser = await chromium.launch({
    ...(process.env["PW_CHROMIUM"]
      ? { executablePath: process.env["PW_CHROMIUM"] }
      : {}),
    args: ["--no-sandbox"],
  });
  try {
    const room = z.object({ id: z.string() }).parse(
      await (
        await fetch(`${ORIGIN}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "perf", maxPlayers: 16 }),
        })
      ).json(),
    );
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    // Independent of the app's own instrumentation, so any build can be measured the same way.
    await page.addInitScript(() => {
      const frames: number[] = [];
      let last = 0;
      const tick = (now: number): void => {
        if (last > 0) frames.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __frames: number[] }).__frames = frames;
    });
    await page.goto(`${ORIGIN}/`);
    await page.locator("#startLoading").click();
    await page.locator(`input[name="room"][value="${room.id}"]`).check();
    await page.getByRole("button", { name: "Join & play" }).click();
    await page.locator("#hud").waitFor();
    await fetch(`${ORIGIN}/api/rooms/${room.id}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: BOTS }),
    });

    // Heavy shooting: thrust, turn and hold fire for the whole run.
    await page.keyboard.down("ArrowUp");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("KeyF");
    await page.waitForTimeout(5000); // warm-up: JIT tiers up, first GCs happen

    const cdp = await page.context().newCDPSession(page);
    if (PROFILERS) {
      await cdp.send("Profiler.enable");
      await cdp.send("HeapProfiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await cdp.send("Profiler.start");
    }
    const traceChunks: unknown[] = [];
    cdp.on("Tracing.dataCollected", (event: { value: unknown[] }) => {
      traceChunks.push(...event.value);
    });
    const traceDone = new Promise<void>((done) =>
      cdp.once("Tracing.tracingComplete", () => done()),
    );
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8,disabled-by-default-v8.gc",
      transferMode: "ReportEvents",
    });
    await page.evaluate(() => {
      (window as unknown as { __frames: number[] }).__frames.length = 0;
      window.labPerf?.reset();
    });

    await page.waitForTimeout(SECONDS * 1000);

    await cdp.send("Tracing.end");
    await traceDone;
    const cpu = PROFILERS ? await cdp.send("Profiler.stop") : null;
    const heap = PROFILERS ? await cdp.send("HeapProfiler.stopSampling") : null;
    const spans = Spans.parse(
      (await page.evaluate(() => window.labPerf?.report())) ?? {},
    );
    const rafFrames = await page.evaluate(
      () => (window as unknown as { __frames: number[] }).__frames,
    );
    const pct = (list: number[], q: number): number => {
      const sorted = [...list].sort((a, b) => a - b);
      return (
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
      );
    };
    const frame = {
      count: rafFrames.length,
      p50: pct(rafFrames, 0.5),
      p95: pct(rafFrames, 0.95),
      p99: pct(rafFrames, 0.99),
      max: Math.max(0, ...rafFrames),
      over16_7: rafFrames.filter((ms) => ms > 16.7 * 1.5).length,
    };
    const stats = z
      .object({ tick: z.object({ durationP99Ms: z.number() }) })
      .parse(await (await fetch(`${ORIGIN}/api/stats`)).json());

    // ---- GC from the trace
    const gcNames = new Map<
      string,
      { count: number; ms: number; maxMs: number }
    >();
    for (const raw of traceChunks) {
      const parsed = TraceEvent.safeParse(raw);
      if (!parsed.success) continue;
      const { name, dur } = parsed.data;
      if (!/GC|Scavenge|MinorGC|MajorGC/.test(name)) continue;
      const entry = gcNames.get(name) ?? { count: 0, ms: 0, maxMs: 0 };
      entry.count += 1;
      entry.ms += (dur ?? 0) / 1000;
      entry.maxMs = Math.max(entry.maxMs, (dur ?? 0) / 1000);
      gcNames.set(name, entry);
    }
    const count = (name: string): number => gcNames.get(name)?.count ?? 0;
    const minorGC = count("MinorGC");
    const majorGC = count("MajorGC");
    const pauseMs = (name: string): number => gcNames.get(name)?.ms ?? 0;
    // Main-thread GC work: scavenges, incremental-marking slices and the atomic finalize pause.
    // (V8.GC_MC_BACKGROUND_* runs on helper threads and does not block frames.)
    const MAIN_THREAD = [
      "V8.GCScavenger",
      "V8.GCIncrementalMarking",
      "V8.GCCompactor",
    ];
    const gcPauseMs = MAIN_THREAD.reduce((sum, name) => sum + pauseMs(name), 0);
    const gcMaxPauseMs = Math.max(
      0,
      ...MAIN_THREAD.map((name) => gcNames.get(name)?.maxMs ?? 0),
    );

    // ---- allocators from the sampling heap profile
    const alloc = new Map<string, number>();
    const walk = (node: HeapNodeT): void => {
      const f = node.callFrame;
      const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").slice(-1)[0] ?? ""}:${f.lineNumber + 1}`;
      alloc.set(key, (alloc.get(key) ?? 0) + node.selfSize);
      node.children.forEach(walk);
    };
    if (heap) walk(HeapNode.parse(heap.profile.head));
    const totalAlloc = [...alloc.values()].reduce((a, b) => a + b, 0);
    const topAlloc = [...alloc.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, bytes]) => ({
        name,
        kb: bytes / 1024,
        percent: (bytes / totalAlloc) * 100,
      }));

    const rows = cpu ? topSelfTime(cpu.profile, 10).rows : [];

    const result = {
      label,
      environment: {
        chromium: browser.version(),
        node: process.version,
        cpus: cpus().length,
        bots: BOTS,
        seconds: SECONDS,
      },
      profilers: PROFILERS,
      frame,
      appFrame: spans["frame"],
      spans: Object.fromEntries(
        Object.entries(spans).filter(([name]) => name !== "frame"),
      ),
      gc: {
        minorGC,
        majorGC,
        mainThreadPauseMs: gcPauseMs,
        maxSinglePauseMs: gcMaxPauseMs,
        events: Object.fromEntries(gcNames),
      },
      topAllocators: topAlloc,
      topSelfTime: rows,
      serverTickP99Ms: stats.tick.durationP99Ms,
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, `perf-${label}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    if (cpu) {
      await writeFile(
        join(outDir, `perf-${label}.cpuprofile`),
        JSON.stringify(cpu.profile),
      );
      await writeFile(
        join(outDir, `flame-${label}.svg`),
        flameGraphSvg(
          cpu.profile,
          `Client CPU profile — ${label} (${BOTS} bots, ${SECONDS}s)`,
        ),
      );
    }
    console.log(
      JSON.stringify(
        {
          frame: result.frame,
          spans: result.spans,
          gc: result.gc,
          topAllocators: topAlloc.slice(0, 5),
          topSelfTime: rows.slice(0, 6),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    server.kill("SIGINT");
  }
}

await main();
