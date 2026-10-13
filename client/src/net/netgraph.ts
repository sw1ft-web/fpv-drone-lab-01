import { query } from "../dom.ts";
import type { Connection } from "./connection.ts";
import type { GameClient } from "./gameclient.ts";
import { NetStatsSampler, formatNetgraph } from "./netstats.ts";

export interface Netgraph {
  toggle(): void;
  update(now: number): void;
}

/** Overlay with the live numbers and two small history charts. Toggle with N. */
export function mountNetgraph(
  root: HTMLElement,
  { connection, game }: { connection: Connection; game: GameClient },
): Netgraph {
  const text = query(root, "pre", HTMLPreElement);
  const canvas = query(root, "canvas", HTMLCanvasElement);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is not available");
  const sampler = new NetStatsSampler({ connection, game });
  let frame = 0;

  const drawSeries = (
    values: readonly number[],
    color: string,
    max: number,
    row: number,
  ): void => {
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
    update(now: number): void {
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
