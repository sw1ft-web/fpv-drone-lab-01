// Backpressure experiment: stream a 200 MB match log to a throttled client and
// sample the server's RSS. Compares pipeline() streaming with a deliberately
// naive readFile() variant (?buffered=1). Output: docs/lab-04/rss.csv + rss-backpressure.svg
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { lineChartSvg } from "../../scripts/lib/svg-chart.ts";
import type { Point } from "../../scripts/lib/svg-chart.ts";

const Listening = z.object({ port: z.number() });
const Stats = z.object({ rssBytes: z.number() });

interface Run {
  readonly mode: string;
  readonly samples: Point[];
  readonly baselineMb: number;
  readonly peakMb: number;
  readonly bytes: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../docs/lab-04");
const TARGET_BYTES = 200 * 1024 * 1024;
const THROTTLE_BYTES_PER_SEC = 20 * 1024 * 1024;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function generateLog(path: string): Promise<void> {
  const line =
    JSON.stringify({ t: 1, type: "chat", from: "Ann", text: "x".repeat(150) }) +
    "\n";
  const lines = Math.ceil(TARGET_BYTES / Buffer.byteLength(line));
  await pipeline(
    Readable.from(
      (function* () {
        for (let i = 0; i < lines; i += 1) yield line;
      })(),
    ),
    createWriteStream(path),
  );
}

function startServer(
  logDir: string,
): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [join(here, "../src/index.ts")], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      DEBUG_ROUTES: "true",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited (${code})`)));
    child.stdout.on("data", (chunk: Buffer) => {
      const line = chunk
        .toString()
        .split("\n")
        .find((entry) => entry.includes("server listening"));
      if (line)
        resolve({ child, port: Listening.parse(JSON.parse(line)).port });
    });
  });
}

const getStats = (port: number): Promise<z.output<typeof Stats>> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/api/stats" }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve(Stats.parse(JSON.parse(body))));
      })
      .on("error", reject);
  });

// Reads the response no faster than THROTTLE_BYTES_PER_SEC by pausing the socket.
function throttledDownload(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        const started = performance.now();
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          const due =
            (received / THROTTLE_BYTES_PER_SEC) * 1000 -
            (performance.now() - started);
          if (due > 5) {
            res.pause();
            setTimeout(() => res.resume(), due);
          }
        });
        res.on("end", () => resolve(received));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function measure(mode: string, logDir: string): Promise<Run> {
  const { child, port } = await startServer(logDir);
  const samples: Point[] = [];
  const origin = performance.now();
  const baseline = (await getStats(port)).rssBytes;
  samples.push([0, baseline / 1048576]);

  const stopSampling = new AbortController();
  const sampler = (async () => {
    while (!stopSampling.signal.aborted) {
      await sleep(250);
      const { rssBytes } = await getStats(port);
      samples.push([(performance.now() - origin) / 1000, rssBytes / 1048576]);
    }
  })();

  const path = `/api/replays/bigmatch-1${mode === "buffered" ? "?buffered=1" : ""}`;
  const bytes = await throttledDownload(port, path);
  stopSampling.abort();
  await sampler;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  const peak = Math.max(...samples.map(([, rss]) => rss));
  console.log(
    `${mode}: downloaded ${(bytes / 1048576).toFixed(0)} MB, RSS baseline ${(baseline / 1048576).toFixed(0)} MB, peak ${peak.toFixed(0)} MB`,
  );
  return { mode, samples, baselineMb: baseline / 1048576, peakMb: peak, bytes };
}

const logDir = await mkdtemp(join(tmpdir(), "fpv-bigmatch-"));
try {
  console.log("generating 200 MB log…");
  await generateLog(join(logDir, "bigmatch-1.ndjson"));
  const streaming = await measure("stream", logDir);
  const buffered = await measure("buffered", logDir);

  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "rss.csv"),
    [
      "mode,t_seconds,rss_mb",
      ...[streaming, buffered].flatMap((run) =>
        run.samples.map(
          ([t, rss]) => `${run.mode},${t.toFixed(2)},${rss.toFixed(1)}`,
        ),
      ),
    ].join("\n") + "\n",
  );
  await writeFile(
    join(outDir, "rss-backpressure.svg"),
    lineChartSvg({
      title: "Server RSS while a client downloads a 200 MB replay at 20 MB/s",
      xLabel: "seconds",
      yLabel: "RSS (MB)",
      series: [
        {
          name: "pipeline() streaming",
          points: streaming.samples,
          color: "#16a34a",
        },
        {
          name: "readFile() buffered (naive)",
          points: buffered.samples,
          color: "#dc2626",
        },
      ],
    }),
  );
  await writeFile(
    join(outDir, "rss-summary.json"),
    JSON.stringify(
      {
        fileMb: 200,
        throttleMbPerSec: 20,
        streaming: {
          baselineMb: +streaming.baselineMb.toFixed(1),
          peakMb: +streaming.peakMb.toFixed(1),
        },
        buffered: {
          baselineMb: +buffered.baselineMb.toFixed(1),
          peakMb: +buffered.peakMb.toFixed(1),
        },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(logDir, { recursive: true, force: true });
}
