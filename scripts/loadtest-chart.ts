/** Merges docs/lab-07/loadtest-{before,high,highest}.json into one capacity chart + table. */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { lineChartSvg } from "./lib/svg-chart.ts";

const Result = z.object({
  players: z.number(),
  tickP50Ms: z.number(),
  tickP99Ms: z.number(),
  eventLoopUtilization: z.number(),
  rssMB: z.number(),
  kbPerSecOut: z.number(),
});
const File = z.object({ results: z.array(Result) });

const rows = new Map<number, z.output<typeof Result>>();
for (const name of ["before", "high", "highest"]) {
  const parsed = File.parse(
    JSON.parse(await readFile(`docs/lab-07/loadtest-${name}.json`, "utf8")),
  );
  for (const r of parsed.results) rows.set(r.players, r);
}
const sorted = [...rows.values()].sort((a, b) => a.players - b.players);
const BUDGET = 1000 / 30;
await writeFile(
  "docs/lab-07/loadtest-capacity.svg",
  lineChartSvg({
    title: "Server tick time vs players (8 per room, 2 shared CPUs)",
    xLabel: "players",
    yLabel: "tick time, ms",
    series: [
      {
        name: "p50",
        points: sorted.map((r) => [r.players, r.tickP50Ms] as const),
      },
      {
        name: "p99",
        points: sorted.map((r) => [r.players, r.tickP99Ms] as const),
      },
      {
        name: "budget 33 ms",
        color: "#dc2626",
        points: sorted.map((r) => [r.players, BUDGET] as const),
      },
    ],
  }),
);
console.log("| players | tick p50 | tick p99 | RSS MB | out KB/s |");
for (const r of sorted)
  console.log(
    `| ${r.players} | ${r.tickP50Ms.toFixed(1)} | ${r.tickP99Ms.toFixed(1)} | ${r.rssMB.toFixed(0)} | ${r.kbPerSecOut.toFixed(0)} |`,
  );
