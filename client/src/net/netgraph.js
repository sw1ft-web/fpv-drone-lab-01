import { NetStatsSampler, formatNetgraph } from "./netstats.js";

/** Overlay with the live numbers and two small history charts. Toggle with N. */
export function mountNetgraph(root, { connection, game }) {
  const text = root.querySelector("pre");
  const canvas = root.querySelector("canvas");
  const context = canvas.getContext("2d");
  const sampler = new NetStatsSampler({ connection, game });
  let frame = 0;

  const drawSeries = (values, color, max, row) => {
    const h = canvas.height / 2;
    context.strokeStyle = color;
    context.beginPath();
    values.forEach((value, i) => {
      const x = (i / 119) * canvas.width;
      const y = row * h + h - 2 - Math.min(1, value / max) * (h - 4);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };

  return {
    toggle() {
      root.hidden = !root.hidden;
    },
    update(now) {
      const stats = sampler.sample(now);
      if (root.hidden || frame++ % 6 !== 0) return;
      text.textContent = formatNetgraph(stats, {
        codec: game.codecName,
        network: connection.network,
      });
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawSeries(sampler.history.rtt, "#66ffcc", 400, 0);
      drawSeries(sampler.history.snapshotGap, "#ffd166", 150, 1);
    },
  };
}
