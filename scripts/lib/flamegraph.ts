/**
 * Renders a V8 .cpuprofile as a static flame graph (SVG, root at the bottom).
 * This is generated from the profile data, it is NOT a DevTools screenshot.
 */
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
      children: z.array(z.number()).optional(),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

const esc = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function flameGraphSvg(
  profileJson: unknown,
  title: string,
  width = 1200,
  rowHeight = 16,
): string {
  const profile = Profile.parse(profileJson);
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<number, number>();
  for (const [index, id] of profile.samples.entries())
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0));

  const total = new Map<number, number>();
  const sum = (id: number): number => {
    const node = nodes.get(id);
    if (!node) return 0;
    let value = self.get(id) ?? 0;
    for (const child of node.children ?? []) value += sum(child);
    total.set(id, value);
    return value;
  };
  const root = profile.nodes[0];
  if (!root) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  // The profile is mostly "(idle)"; drawing it would squash everything else.
  const grand =
    sum(root.id) -
    profile.nodes
      .filter((n) => n.callFrame.functionName === "(idle)")
      .reduce((acc, n) => acc + (self.get(n.id) ?? 0), 0);

  const rects: string[] = [];
  let maxDepth = 0;
  const place = (id: number, depth: number, x: number): void => {
    const node = nodes.get(id);
    if (!node) return;
    const name = node.callFrame.functionName;
    const value = name === "(idle)" ? 0 : (total.get(id) ?? 0);
    const w = (value / grand) * width;
    if (w < 1.5) return;
    maxDepth = Math.max(maxDepth, depth);
    const label = name || "(anonymous)";
    const hue = label
      .split("")
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    rects.push(
      `<g><title>${esc(label)} ${(value / 1000).toFixed(0)} ms</title><rect x="${x.toFixed(1)}" y="__Y${depth}__" width="${w.toFixed(1)}" height="${rowHeight - 1}" fill="hsl(${(hue % 50) + 5},80%,${60 - (depth % 3) * 5}%)"/>${w > 40 ? `<text x="${(x + 3).toFixed(1)}" y="__T${depth}__" font-size="10" font-family="monospace">${esc(label.slice(0, Math.floor(w / 6)))}</text>` : ""}</g>`,
    );
    let cursor = x;
    for (const child of node.children ?? []) {
      const childValue =
        nodes.get(child)?.callFrame.functionName === "(idle)"
          ? 0
          : (total.get(child) ?? 0);
      place(child, depth + 1, cursor);
      cursor += (childValue / grand) * width;
    }
  };
  place(root.id, 0, 0);
  const height = (maxDepth + 1) * rowHeight + 36;
  let svg = rects.join("");
  for (let d = 0; d <= maxDepth; d += 1) {
    svg = svg
      .replaceAll(`__Y${d}__`, String(height - 8 - (d + 1) * rowHeight))
      .replaceAll(`__T${d}__`, String(height - 8 - (d + 1) * rowHeight + 11));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="8" y="16" font-size="13" font-family="sans-serif" font-weight="bold">${esc(title)}</text>${svg}</svg>\n`;
}
