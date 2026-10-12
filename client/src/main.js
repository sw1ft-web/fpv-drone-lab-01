import "./style.css";
import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { setupCanvas } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { drawLoadingScreen } from "./render/loading.js";
import { loadAll, loadJson, benchmarkLoadAll } from "./assets/loader.js";
import { AudioManager } from "./audio/audio.js";
import { Lobby } from "./lobby/lobby.js";
import { joinRoom } from "./net/session.js";
import { mountChat } from "./chat/panel.js";
import { mountLobby } from "./lobby/view.js";
import { attachHudEvents } from "./hud.js";
import { installFailureGallery } from "./debug/failures.js";
import { GameClient } from "./net/gameclient.js";
import { mountNetgraph } from "./net/netgraph.js";
import { Effects } from "./render/effects.js";
import { commandToBits } from "@fpv/shared";

const canvas = document.querySelector("#gameCanvas");
const loadingPanel = document.querySelector("#loadingPanel");
const startLoadingButton = document.querySelector("#startLoading");
const retryLoadingButton = document.querySelector("#retryLoading");
const loadingMessage = document.querySelector("#loadingMessage");
const lobbyRoot = document.querySelector("#lobby");
const hudRoot = document.querySelector("#hud");
const failureRoot = document.querySelector("#failureGallery");
const chatRoot = document.querySelector("#chat");
const netgraphRoot = document.querySelector("#netgraph");

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

const effects = new Effects();
let assets = null;
let game = null;
let arena = null;
let arenaSize = { width: 1600, height: 900 };
let loop = null;
let loadingController = null;
let detachHud = null;
let detachEffects = null;
let netgraph = null;
let session = null;
let chat = null;

/** `?lat=80&jitter=20&drop=0.05&codec=json` simulates a bad network and picks the wire format. */
const params = new URLSearchParams(location.search);
const networkFromUrl = () => ({
  latencyMs: Number(params.get("lat") ?? 0) || 0,
  jitterMs: Number(params.get("jitter") ?? 0) || 0,
  drop: Math.min(1, Number(params.get("drop") ?? 0) || 0),
});
const codecFromUrl = () => (params.get("codec") === "json" ? "json" : "binary");

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
        const label = item
          ? `Loaded ${item.type}: ${item.id}`
          : "Loading assets concurrently…";
        loadingMessage.textContent = label;
        renderLoading({ completed, total, percent, label });
      },
      onRetry: ({ item, attempt, delayMs }) => {
        loadingMessage.textContent = `Retry ${attempt} for ${item.id} in ${delayMs} ms`;
      },
    });

    audio.setBuffers(assets.audio);
    renderLoading({
      completed: 8,
      total: 8,
      percent: 1,
      label: "Assets ready — opening lobby",
    });
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
  const { room, playerName } = event.detail;
  lobby.leave();
  lobbyView.hide();
  await audio.unlock();

  try {
    session?.connection.close();
    chat?.destroy();
    session = await joinRoom({
      roomId: room.id,
      name: playerName,
      codec: codecFromUrl(),
      network: networkFromUrl(),
    });
  } catch (error) {
    // Could not join (room full, server down...): go back to the lobby with the reason.
    lobbyView.show();
    await lobby.show();
    lobbyView.setStatus(`Join failed: ${error.message}`, "error");
    return;
  }

  const { connection, welcome } = session;
  chat = mountChat(chatRoot, { connection, playerId: welcome.playerId });
  chat.show();
  startGame({ room: welcome.room, playerName });
});

function startGame({ room, playerName }) {
  loop?.stop();
  detachHud?.();
  detachEffects?.();
  game?.destroy();
  audio.detach();

  const { connection, welcome } = session;
  arena = assets.json.get(room.arenaId) ?? {};
  arenaSize = welcome.arena ?? arenaSize;
  game = new GameClient({ connection, welcome });
  audio.attach(game);
  detachHud = attachHudEvents(game, { scoreEl, eventEl });
  const onExploded = (event) => {
    const { x, y, kind } = event.detail;
    if (x !== undefined) effects.explode(x, y, kind === "ship" ? 28 : 14);
  };
  game.addEventListener("exploded", onExploded);
  detachEffects = () => game?.removeEventListener("exploded", onExploded);
  netgraph = mountNetgraph(netgraphRoot, { connection, game });

  roomNameEl.textContent = room.name;
  playerNameEl.textContent = playerName;
  scoreEl.textContent = "0";
  hudRoot.hidden = false;

  loop = createLoop({ step: 1 / 60, simulate, render });
  loop.start();
}

/** One 60 Hz step: sample the keyboard into a command, predict locally, queue it for the server. */
function simulate(dt) {
  if (!game) return;
  game.step(
    commandToBits({
      left: input.isDown("KeyA") || input.isDown("ArrowLeft"),
      right: input.isDown("KeyD") || input.isDown("ArrowRight"),
      thrust: input.isDown("KeyW") || input.isDown("ArrowUp"),
      brake: input.isDown("Space"),
      fire: input.isDown("KeyF") || input.justPressed("Space"),
    }),
  );
  effects.update(dt);
}

function render(alpha, stats) {
  if (!game) return;
  const now = performance.now();
  const view = game.view(alpha, now);
  drawScene(
    ctx.context,
    ctx.cssWidth,
    ctx.cssHeight,
    view,
    effects,
    assets,
    arena,
    arenaSize,
    now,
  );
  netgraph?.update(now);
  stepsEl.textContent = stats.stepsPerSecond.toFixed(0);
  framesEl.textContent = stats.framesPerSecond.toFixed(0);
  frameTimeEl.textContent = stats.frameTimeMs.toFixed(2);
  if (view.own) hpEl.textContent = `${view.own.hp}/100`;
  entitiesEl.textContent = String(
    view.ships.length +
      view.bullets.length +
      view.asteroids.length +
      view.pickups.length,
  );
}

window.addEventListener("keydown", (event) => {
  const typing =
    event.target instanceof HTMLElement && event.target.tagName === "INPUT";
  if (typing) return;
  if (event.code === "KeyN" && netgraph) netgraph.toggle();
  if (event.code === "Enter" && chat) {
    event.preventDefault();
    chat.focusInput();
  }
});

window.addEventListener("resize", () => {
  if (!game) {
    renderLoading({
      label: assets
        ? "Assets loaded"
        : "Click Start loading to unlock Web Audio",
    });
  }
});

window.lab05 = {
  get game() {
    return game;
  },
  /** e.g. lab05.setNetwork({ latencyMs: 120, jitterMs: 30, drop: 0.05 }) */
  setNetwork: (network) => session?.connection.setNetwork(network),
};

window.lab04 = {
  get connection() {
    return session?.connection;
  },
};

window.lab03 = {
  abortLoading: () =>
    loadingController?.abort(new DOMException("Manual abort", "AbortError")),
  benchmark: async () => {
    if (!assets) throw new Error("Load assets first");
    const result = await benchmarkLoadAll(assets.manifest, {
      audioContext: audio.context,
    });
    console.table(result);
    return result;
  },
  refreshRooms: () => lobby.refresh(),
};
