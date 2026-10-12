import type { GameClient } from "./net/gameclient.ts";

export function attachHudEvents(
  game: GameClient,
  { scoreEl, eventEl }: { scoreEl: HTMLElement; eventEl: HTMLElement },
): () => void {
  const offs = [
    game.events.on("scoreChanged", ({ score }) => {
      scoreEl.textContent = String(score);
    }),
    game.events.on("fired", () => {
      eventEl.textContent = "Event bus: fired";
    }),
    game.events.on("hit", ({ target }) => {
      eventEl.textContent = `Event bus: hit (${target})`;
    }),
    game.events.on("exploded", ({ kind }) => {
      eventEl.textContent = `Event bus: exploded (${kind})`;
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
