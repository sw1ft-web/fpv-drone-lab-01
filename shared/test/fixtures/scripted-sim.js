import {
  World,
  commandFromBits,
  createRng,
  hashWorld,
} from "../../src/index.js";

/** Runs a fixed script of pseudo-random pilot inputs and returns the final world hash. */
export function runScriptedSim({
  seed = 1234,
  steps = 1800,
  ships = 2,
  integrate,
} = {}) {
  const world = new World({ seed, ...(integrate ? { integrate } : {}) });
  world.populate();
  const pilots = [];
  for (let i = 0; i < ships; i += 1)
    pilots.push({ ship: world.addShip(), seq: 0 });

  const script = createRng(seed ^ 0x9e3779b9);
  for (let step = 0; step < steps; step += 1) {
    const commands = new Map();
    for (const pilot of pilots) {
      pilot.seq += 1;
      const bits =
        (script.chance(0.5) ? 4 : 0) |
        (script.chance(0.25) ? 1 : 0) |
        (script.chance(0.25) ? 2 : 0) |
        (script.chance(0.15) ? 16 : 0);
      commands.set(pilot.ship.id, { ...commandFromBits(bits), seq: pilot.seq });
    }
    world.step(1 / 60, commands);
  }
  return { hash: hashWorld(world), world };
}
