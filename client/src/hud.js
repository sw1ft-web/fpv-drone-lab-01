export function attachHudEvents(world, { scoreEl, eventEl }) {
  const onScore = (event) => {
    scoreEl.textContent = String(event.detail.score);
  };
  const onFired = () => {
    eventEl.textContent = "Event bus: fired";
  };
  const onHit = (event) => {
    eventEl.textContent = `Event bus: hit (${event.detail.target})`;
  };
  const onExploded = (event) => {
    eventEl.textContent = `Event bus: exploded (${event.detail.kind})`;
  };

  world.addEventListener("scoreChanged", onScore);
  world.addEventListener("fired", onFired);
  world.addEventListener("hit", onHit);
  world.addEventListener("exploded", onExploded);

  return () => {
    world.removeEventListener("scoreChanged", onScore);
    world.removeEventListener("fired", onFired);
    world.removeEventListener("hit", onHit);
    world.removeEventListener("exploded", onExploded);
  };
}
