import "./style.css";
import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { setupCanvas } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { drawLoadingScreen } from "./render/loading.js";
import { loadAll, loadJson, benchmarkLoadAll } from "./assets/loader.js";
import { AudioManager } from "./audio/audio.js";
import { Lobby } from "./lobby/lobby.js";
import { mountLobby } from "./lobby/view.js";
import { attachHudEvents } from "./hud.js";
import { installFailureGallery } from "./debug/failures.js";
import { World } from "./sim/world.js";
import { Ship } from "./sim/ship.js";
import { Bullet } from "./sim/bullet.js";
import { Asteroid } from "./sim/asteroid.js";
import { Pickup } from "./sim/pickup.js";
import { Explosion } from "./sim/explosion.js";
import { createHomingBehavior } from "./sim/homing.js";

const canvas = document.querySelector("#gameCanvas");
const loadingPanel = document.querySelector("#loadingPanel");
const startLoadingButton = document.querySelector("#startLoading");
const retryLoadingButton = document.querySelector("#retryLoading");
const loadingMessage = document.querySelector("#loadingMessage");
const lobbyRoot = document.querySelector("#lobby");
const hudRoot = document.querySelector("#hud");
const failureRoot = document.querySelector("#failureGallery");

const stepsEl = document.querySelector("#steps");
const framesEl = document.querySelector("#frames");
const frameTimeEl = document.querySelector("#frameTime");
const hpEl = document.querySelector("#hp");
const scoreEl = document.querySelector("#score");
const entitiesEl = document.querySelector("#entities");
const roomNameEl = document.querySelector("#roomName");
const playerNameEl = document.querySelector("#playerNameHud");
const eventEl = document.querySelector("#eventStatus");

const ctx = setupCanvas(canvas);
const input = createInput(window);
const audio = new AudioManager();
const lobby = new Lobby();
const lobbyView = mountLobby(lobby, lobbyRoot);
installFailureGallery(failureRoot);

const classes = { Ship, Bullet, Asteroid, Pickup, Explosion };
let assets = null;
let world = null;
let ship = null;
let arena = null;
let loop = null;
let previousShip = null;
let loadingController = null;
let detachHud = null;

function renderLoading(state = {}) {
  drawLoadingScreen(ctx.context, ctx.cssWidth, ctx.cssHeight, state);
}

renderLoading({ label: "Click Start loading to unlock Web Audio" });

startLoadingButton.addEventListener("click", prepareAssets);
retryLoadingButton.addEventListener("click", prepareAssets);

async function prepareAssets() {
  loadingController?.abort();
  loadingController = new AbortController();
  const { signal } = loadingController;

  startLoadingButton.disabled = true;
  retryLoadingButton.hidden = true;
  loadingMessage.textContent = "Creating AudioContext after your click…";
  renderLoading({ label: "Unlocking Web Audio…" });

  try {
    const audioContext = await audio.unlock();
    const manifest = await loadJson("/assets/manifest.json", { signal });

    assets = await loadAll(manifest, {
      audioContext,
      signal,
      onProgress: ({ completed, total, percent, item }) => {
        const label = item ? `Loaded ${item.type}: ${item.id}` : "Loading assets concurrently…";
        loadingMessage.textContent = label;
        renderLoading({ completed, total, percent, label });
      },
      onRetry: ({ item, attempt, delayMs }) => {
        loadingMessage.textContent = `Retry ${attempt} for ${item.id} in ${delayMs} ms`;
      },
    });

    audio.setBuffers(assets.audio);
    renderLoading({ completed: 8, total: 8, percent: 1, label: "Assets ready — opening lobby" });
    loadingPanel.hidden = true;
    lobbyView.show();
    await lobby.show();
  } catch (error) {
    if (error?.name === "AbortError") return;
    const message = `${error.name}: ${error.message}`;
    loadingMessage.textContent = message;
    retryLoadingButton.hidden = false;
    startLoadingButton.disabled = false;
    renderLoading({ label: "Asset loading failed", error: message });
  }
}

lobby.addEventListener("joined", async (event) => {
  lobby.leave();
  lobbyView.hide();
  await audio.unlock();
  startGame(event.detail);
});

function startGame({ room, playerName }) {
  loop?.stop();
  detachHud?.();
  audio.detach();

  arena = assets.json.get(room.arenaId) ?? {};
  world = new World(ctx.cssWidth, ctx.cssHeight, classes);
  ship = new Ship({ x: ctx.cssWidth / 2, y: ctx.cssHeight / 2 });
  world.spawn(ship);

  for (let i = 0; i < (arena.asteroids ?? 7); i += 1) spawnAsteroid();
  spawnInitialPickups(arena.pickups ?? 1);

  const homingAsteroid = new Asteroid(
    { x: ctx.cssWidth * 0.8, y: ctx.cssHeight * 0.25 },
    { x: -25, y: 10 },
    30,
  );
  homingAsteroid.homing = createHomingBehavior("ship", 1.1);
  world.spawn(homingAsteroid);

  previousShip = { x: ship.pos.x, y: ship.pos.y, angle: ship.angle };
  audio.attach(world);
  detachHud = attachHudEvents(world, { scoreEl, eventEl });

  roomNameEl.textContent = room.name;
  playerNameEl.textContent = playerName;
  scoreEl.textContent = "0";
  hudRoot.hidden = false;

  loop = createLoop({ step: 1 / 60, simulate, render });
  loop.start();
}

function spawnInitialPickups(count) {
  const types = ["shield", "rapid-fire"];
  for (let i = 0; i < count; i += 1) {
    world.spawn(
      new Pickup(
        {
          x: ctx.cssWidth * (0.3 + i * 0.3),
          y: ctx.cssHeight * (0.35 + (i % 2) * 0.25),
        },
        types[i % types.length],
      ),
    );
  }
}

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
  if (!world || !ship) return;
  previousShip.x = ship.pos.x;
  previousShip.y = ship.pos.y;
  previousShip.angle = ship.angle;
  world.width = ctx.cssWidth;
  world.height = ctx.cssHeight;
  world.step(dt, input);

  if ([...world.ofKind("asteroid")].length < Math.max(4, (arena.asteroids ?? 7) - 1)) {
    spawnAsteroid();
  }
}

function render(alpha, stats) {
  drawScene(
    ctx.context,
    ctx.cssWidth,
    ctx.cssHeight,
    world,
    previousShip,
    ship,
    alpha,
    assets,
    arena,
  );
  stepsEl.textContent = stats.stepsPerSecond.toFixed(0);
  framesEl.textContent = stats.framesPerSecond.toFixed(0);
  frameTimeEl.textContent = stats.frameTimeMs.toFixed(2);
  hpEl.textContent = `${ship.hp}/100`;
  entitiesEl.textContent = String([...world].length);
}

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyF" && world && ship) ship.fire(world);
});

window.addEventListener("resize", () => {
  if (world) {
    world.width = ctx.cssWidth;
    world.height = ctx.cssHeight;
  } else {
    renderLoading({ label: assets ? "Assets loaded" : "Click Start loading to unlock Web Audio" });
  }
});

window.lab03 = {
  abortLoading: () => loadingController?.abort(new DOMException("Manual abort", "AbortError")),
  benchmark: async () => {
    if (!assets) throw new Error("Load assets first");
    const result = await benchmarkLoadAll(assets.manifest, { audioContext: audio.context });
    console.table(result);
    return result;
  },
  refreshRooms: () => lobby.refresh(),
};
