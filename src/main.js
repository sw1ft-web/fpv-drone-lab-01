import "./style.css";
import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { setupCanvas } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { World } from "./sim/world.js";
import { Ship } from "./sim/ship.js";
import { Bullet } from "./sim/bullet.js";
import { Asteroid } from "./sim/asteroid.js";
import { Pickup } from "./sim/pickup.js";
import { Explosion } from "./sim/explosion.js";
import { createHomingBehavior } from "./sim/homing.js";

const canvas = document.querySelector("#gameCanvas");
const stepsEl = document.querySelector("#steps");
const framesEl = document.querySelector("#frames");
const frameTimeEl = document.querySelector("#frameTime");
const experimentEl = document.querySelector("#experiment");
const hpEl = document.querySelector("#hp");
const scoreEl = document.querySelector("#score");
const entitiesEl = document.querySelector("#entities");

const ctx = setupCanvas(canvas);
const input = createInput(window);

const classes = { Ship, Bullet, Asteroid, Pickup, Explosion };
const world = new World(ctx.cssWidth, ctx.cssHeight, classes);

const ship = new Ship({
  x: ctx.cssWidth / 2,
  y: ctx.cssHeight / 2,
});
world.spawn(ship);

for (let i = 0; i < 8; i += 1) {
  spawnAsteroid();
}

world.spawn(
  new Pickup(
    { x: ctx.cssWidth * 0.25, y: ctx.cssHeight * 0.3 },
    "shield",
  ),
);
world.spawn(
  new Pickup(
    { x: ctx.cssWidth * 0.75, y: ctx.cssHeight * 0.65 },
    "rapid-fire",
  ),
);

const homingAsteroid = new Asteroid(
  { x: ctx.cssWidth * 0.8, y: ctx.cssHeight * 0.25 },
  { x: -25, y: 10 },
  30,
);
homingAsteroid.homing = createHomingBehavior("ship", 1.1);
world.spawn(homingAsteroid);

const previousShip = {
  x: ship.pos.x,
  y: ship.pos.y,
  angle: ship.angle,
};

let experimentMode = "normal";
let experimentFrameCounter = 0;

function spawnAsteroid() {
  const margin = 40;
  const asteroid = new Asteroid(
    {
      x: margin + Math.random() * Math.max(1, ctx.cssWidth - margin * 2),
      y: margin + Math.random() * Math.max(1, ctx.cssHeight - margin * 2),
    },
    {
      x: (Math.random() - 0.5) * 90,
      y: (Math.random() - 0.5) * 90,
    },
  );
  world.spawn(asteroid);
}

function simulate(dt) {
  previousShip.x = ship.pos.x;
  previousShip.y = ship.pos.y;
  previousShip.angle = ship.angle;

  world.width = ctx.cssWidth;
  world.height = ctx.cssHeight;
  world.step(dt, input);

  if ([...world.ofKind("asteroid")].length < 7) {
    spawnAsteroid();
  }
}

function render(alpha, stats) {
  if (experimentMode === "blocking" && ++experimentFrameCounter % 60 === 0) {
    const end = performance.now() + 100;
    while (performance.now() < end) {
    performance.now();
  }
}

  drawScene(ctx.context, ctx.cssWidth, ctx.cssHeight, world, previousShip, ship, alpha);

  stepsEl.textContent = stats.stepsPerSecond.toFixed(0);
  framesEl.textContent = stats.framesPerSecond.toFixed(0);
  frameTimeEl.textContent = stats.frameTimeMs.toFixed(2);
  hpEl.textContent = `${ship.hp}/100`;
  scoreEl.textContent = String(world.score);
  entitiesEl.textContent = String([...world].length);
}

function setExperiment(mode) {
  experimentMode = mode;
  experimentFrameCounter = 0;
  experimentEl.textContent =
    mode === "normal"
      ? "Lab 02: entities + collisions"
      : mode === "blocking"
        ? "Experiment 1: 100 ms synchronous block"
        : mode === "interval"
          ? "Experiment 2: setInterval comparison is documented in README"
          : "Experiment 3: variable-step comparison is documented in README";
}

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyF") {
    // Fixed version of the this bug: the wrapper preserves the ship receiver.
    ship.fire(world);
  }
  if (event.code === "Digit1") setExperiment("blocking");
  if (event.code === "Digit2") setExperiment("interval");
  if (event.code === "Digit3") setExperiment("variable");
  if (event.code === "Digit0") setExperiment("normal");
});

// Intentionally demonstrated in README:
// window.addEventListener("keydown", ship.fire) would lose the intended `this`.
// The chosen fix is the wrapper above: () => ship.fire(world).

window.addEventListener("resize", () => {
  world.width = ctx.cssWidth;
  world.height = ctx.cssHeight;
});

setExperiment("normal");
const loop = createLoop({
  step: 1 / 60,
  simulate,
  render,
});
loop.start();
