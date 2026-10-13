/** Minimal dependency-free SVG line chart used for the lab measurement graphs. */
const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function niceMax(value) {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

/**
 * @param {{title: string, xLabel: string, yLabel: string, width?: number, height?: number,
 *          yMax?: number, series: {name: string, color?: string, points: [number, number][]}[]}} options
 */
export function lineChartSvg({
  title,
  xLabel,
  yLabel,
  series,
  width = 760,
  height = 380,
  yMax,
}) {
  const margin = { top: 44, right: 24, bottom: 52, left: 72 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const all = series.flatMap((entry) => entry.points);
  const xMax = Math.max(1e-9, ...all.map(([x]) => x));
  const yTop = yMax ?? niceMax(Math.max(1e-9, ...all.map(([, y]) => y)) * 1.05);
  const sx = (x) => margin.left + (x / xMax) * plotW;
  const sy = (y) => margin.top + plotH - (y / yTop) * plotH;

  const grid = [];
  for (let i = 0; i <= 5; i += 1) {
    const value = (yTop / 5) * i;
    const y = sy(value);
    grid.push(
      `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e5e7eb"/>`,
      `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#4b5563">${+value.toFixed(1)}</text>`,
    );
  }
  for (let i = 0; i <= 5; i += 1) {
    const value = (xMax / 5) * i;
    grid.push(
      `<text x="${sx(value)}" y="${height - margin.bottom + 18}" text-anchor="middle" font-size="11" fill="#4b5563">${+value.toFixed(1)}</text>`,
    );
  }

  const lines = series.map((entry, index) => {
    const color = entry.color ?? PALETTE[index % PALETTE.length];
    const d = entry.points
      .map(
        ([x, y], i) =>
          `${i === 0 ? "M" : "L"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`,
      )
      .join(" ");
    const legendX = margin.left + 12 + index * 190;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>
<rect x="${legendX}" y="${margin.top - 28}" width="14" height="4" fill="${color}"/>
<text x="${legendX + 20}" y="${margin.top - 22}" font-size="12" fill="#111827">${esc(entry.name)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<text x="${width / 2}" y="18" text-anchor="middle" font-size="14" font-weight="600" fill="#111827">${esc(title)}</text>
${grid.join("\n")}
<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#9ca3af"/>
<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#9ca3af"/>
${lines.join("\n")}
<text x="${margin.left + plotW / 2}" y="${height - 10}" text-anchor="middle" font-size="12" fill="#374151">${esc(xLabel)}</text>
<text transform="translate(16 ${margin.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#374151">${esc(yLabel)}</text>
</svg>
`;
}
