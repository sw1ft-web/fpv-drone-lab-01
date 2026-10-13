import "./style.css";
import { createLoop } from "./loop.ts";
import { createInput } from "./input.ts";
import { setupCanvas } from "./render/canvas.ts";
import { drawScene } from "./render/draw.ts";
import { drawLoadingScreen } from "./render/loading.ts";
import { isAbortError } from "./assets/http.ts";
import { loadAll, loadManifest, benchmarkLoadAll } from "./assets/loader.ts";
import type { Assets } from "./assets/loader.ts";
import { ArenaStyleSchema } from "./assets/schema.ts";
import type { ArenaStyle } from "./assets/schema.ts";
import { query } from "./dom.ts";
import { AudioManager } from "./audio/audio.ts";
import { Lobby } from "./lobby/lobby.ts";
import { joinRoom } from "./net/session.ts";
import type { Joined } from "./net/session.ts";
import { mountChat } from "./chat/panel.ts";
import type { ChatPanel } from "./chat/panel.ts";
import { mountLobby } from "./lobby/view.ts";
import { attachHudEvents } from "./hud.ts";
import { installFailureGallery } from "./debug/failures.ts";
import { GameClient } from "./net/gameclient.ts";
import { mountNetgraph } from "./net/netgraph.ts";
import type { Netgraph } from "./net/netgraph.ts";
import { Effects } from "./render/effects.ts";
import { commandToBits } from "@fpv/shared";
import type { CodecName, NetworkConditions } from "@fpv/shared";
import type { RoomInfo } from "@fpv/shared/protocol";
import type { Loop, LoopStats } from "./loop.ts";
import type { LoadingState } from "./render/loading.ts";

declare global {
  interface Window {
    lab05: {
      readonly game: GameClient | null;
      setNetwork(network: Partial<NetworkConditions>): void;
    };
    lab04: { readonly connection: Joined["connection"] | undefined };
    lab03: {
      abortLoading(): void;
      benchmark(): Promise<unknown>;
      refreshRooms(): Promise<void>;
    };
  }
}

const page = document.body;
const canvas = query(page, "#gameCanvas", HTMLCanvasElement);
const loadingPanel = query(page, "#loadingPanel", HTMLElement);
const startLoadingButton = query(page, "#startLoading", HTMLButtonElement);
const retryLoadingButton = query(page, "#retryLoading", HTMLButtonElement);
const loadingMessage = query(page, "#loadingMessage", HTMLElement);
const lobbyRoot = query(page, "#lobby", HTMLElement);
const hudRoot = query(page, "#hud", HTMLElement);
const failureRoot = query(page, "#failureGallery", HTMLElement);
const chatRoot = query(page, "#chat", HTMLElement);
const netgraphRoot = query(page, "#netgraph", HTMLElement);

const stepsEl = query(page, "#steps", HTMLElement);
const framesEl = query(page, "#frames", HTMLElement);
const frameTimeEl = query(page, "#frameTime", HTMLElement);
const hpEl = query(page, "#hp", HTMLElement);
const scoreEl = query(page, "#score", HTMLElement);
const entitiesEl = query(page, "#entities", HTMLElement);
const roomNameEl = query(page, "#roomName", HTMLElement);
const playerNameEl = query(page, "#playerNameHud", HTMLElement);
const eventEl = query(page, "#eventStatus", HTMLElement);

const ctx = setupCanvas(canvas);
const input = createInput(window);
const audio = new AudioManager();
const lobby = new Lobby();
const lobbyView = mountLobby(lobby, lobbyRoot);
installFailureGallery(failureRoot);

const effects = new Effects();
let assets: Assets | null = null;
let game: GameClient | null = null;
let arena: ArenaStyle = {};
let arenaSize = { width: 1600, height: 900 };
let loop: Loop | null = null;
let loadingController: AbortController | null = null;
let detachHud: (() => void) | null = null;
let detachEffects: (() => void) | null = null;
let netgraph: Netgraph | null = null;
let session: Joined | null = null;
let chat: ChatPanel | null = null;

/** `?lat=80&jitter=20&drop=0.05&codec=json` simulates a bad network and picks the wire format. */
const params = new URLSearchParams(location.search);
const networkFromUrl = (): NetworkConditions => ({
  latencyMs: Number(params.get("lat") ?? 0) || 0,
  jitterMs: Number(params.get("jitter") ?? 0) || 0,
  drop: Math.min(1, Number(params.get("drop") ?? 0) || 0),
});
const codecFromUrl = (): CodecName =>
  params.get("codec") === "json" ? "json" : "binary";

function renderLoading(state: LoadingState = {}): void {
  drawLoadingScreen(ctx.context, ctx.cssWidth, ctx.cssHeight, state);
}

renderLoading({ label: "Click Start loading to unlock Web Audio" });

startLoadingButton.addEventListener("click", () => void prepareAssets());
retryLoadingButton.addEventListener("click", () => void prepareAssets());

async function prepareAssets(): Promise<void> {
  loadingController?.abort();
  loadingController = new AbortController();
  const { signal } = loadingController;

  startLoadingButton.disabled = true;
  retryLoadingButton.hidden = true;
  loadingMessage.textContent = "Creating AudioContext after your click…";
  renderLoading({ label: "Unlocking Web Audio…" });

  try {
    const audioContext = await audio.unlock();
    const manifest = await loadManifest("/assets/manifest.json", { signal });

    const loaded = await loadAll(manifest, {
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

    assets = loaded;
    audio.setBuffers(loaded.audio);
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
    if (isAbortError(error)) return;
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    loadingMessage.textContent = message;
    retryLoadingButton.hidden = false;
    startLoadingButton.disabled = false;
    renderLoading({ label: "Asset loading failed", error: message });
  }
}

lobby.events.on("joined", (joinedRoom) => void onJoined(joinedRoom));

async function onJoined({
  room,
  playerName,
}: {
  room: RoomInfo;
  playerName: string;
}): Promise<void> {
  lobby.leave();
  lobbyView.hide();
  await audio.unlock();

  let joined: Joined;
  try {
    session?.connection.close();
    chat?.destroy();
    joined = await joinRoom({
      roomId: room.id,
      name: playerName,
      codec: codecFromUrl(),
      network: networkFromUrl(),
    });
    session = joined;
  } catch (error) {
    // Could not join (room full, server down...): go back to the lobby with the reason.
    lobbyView.show();
    await lobby.show();
    lobbyView.setStatus(
      `Join failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  const { connection, welcome } = joined;
  chat = mountChat(chatRoot, { connection, playerId: welcome.playerId });
  chat.show();
  startGame(joined, { room: welcome.room, playerName });
}

function startGame(
  { connection, welcome }: Joined,
  { room, playerName }: { room: RoomInfo; playerName: string },
): void {
  loop?.stop();
  detachHud?.();
  detachEffects?.();
  game?.destroy();
  audio.detach();

  const client = new GameClient({ connection, welcome });
  game = client;
  const style = ArenaStyleSchema.safeParse(assets?.json.get(room.arenaId));
  arena = style.success ? style.data : {};
  arenaSize = welcome.arena;
  audio.attach(client);
  detachHud = attachHudEvents(client, { scoreEl, eventEl });
  detachEffects = client.events.on("exploded", ({ x, y, kind }) =>
    effects.explode(x, y, kind === "ship" ? 28 : 14),
  );
  netgraph = mountNetgraph(netgraphRoot, { connection, game: client });

  roomNameEl.textContent = room.name;
  playerNameEl.textContent = playerName;
  scoreEl.textContent = "0";
  hudRoot.hidden = false;

  loop = createLoop({ step: 1 / 60, simulate, render });
  loop.start();
}

/** One 60 Hz step: sample the keyboard into a command, predict locally, queue it for the server. */
function simulate(dt: number): void {
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

function render(alpha: number, stats: LoopStats): void {
  if (!game || !assets) return;
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
      audioContext: audio.context ?? undefined,
    });
    console.table(result);
    return result;
  },
  refreshRooms: () => lobby.refresh(),
};
