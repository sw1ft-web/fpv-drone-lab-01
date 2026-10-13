/**
 * Summarises a V8 .cpuprofile (from `node --cpu-prof`): top functions by SELF time,
 * plus the share of time spent in GC, idle and "program" pseudo-nodes.
 *
 *   node scripts/cpuprofile-top.ts <file.cpuprofile> [topN]
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

const Profile = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({
        functionName: z.string(),
        url: z.string(),
        lineNumber: z.number(),
      }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

export interface Row {
  readonly name: string;
  readonly selfMs: number;
  readonly percent: number;
}

export function topSelfTime(
  profileJson: unknown,
  topN = 10,
): { total: number; rows: Row[] } {
  const profile = Profile.parse(profileJson);
  const byNode = new Map(
    profile.nodes.map((node) => [node.id, node.callFrame]),
  );
  const self = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const delta = (profile.timeDeltas[index] ?? 0) / 1000;
    const frame = byNode.get(id);
    if (!frame) return;
    const file = frame.url.split("/").slice(-2).join("/");
    const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
    const key = frame.url ? `${name} ${file}:${frame.lineNumber + 1}` : name;
    self.set(key, (self.get(key) ?? 0) + delta);
    total += delta;
  });
  const rows = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, selfMs]) => ({
      name,
      selfMs,
      percent: (selfMs / total) * 100,
    }));
  return { total, rows };
}

if (process.argv[1]?.endsWith("cpuprofile-top.ts")) {
  const file = process.argv[2];
  if (!file)
    throw new Error("usage: cpuprofile-top.ts <file.cpuprofile> [topN]");
  const { total, rows } = topSelfTime(
    JSON.parse(await readFile(file, "utf8")),
    Number(process.argv[3] ?? 12),
  );
  console.log(`total sampled: ${total.toFixed(0)} ms`);
  for (const row of rows)
    console.log(
      `${row.percent.toFixed(1).padStart(5)}%  ${row.selfMs.toFixed(0).padStart(6)} ms  ${row.name}`,
    );
}
