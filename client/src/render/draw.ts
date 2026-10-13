import type { Assets, LoadedImage } from "../assets/loader.ts";
import type { ArenaStyle } from "../assets/schema.ts";
import type {
  AsteroidView,
  BulletView,
  PickupView,
  ShipView,
  WorldView,
} from "../net/gameclient.ts";
import { MAX_LIFE } from "./effects.ts";
import type { Effects } from "./effects.ts";

type Ctx = CanvasRenderingContext2D;

export interface Viewport {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The arena has a fixed logical size (shared/constants); the canvas shows it
 * letterboxed in the middle of the window so that the simulation never
 * depends on the browser size.
 */
export function arenaViewport(
  cssWidth: number,
  cssHeight: number,
  arenaWidth: number,
  arenaHeight: number,
): Viewport {
  const scale = Math.min(cssWidth / arenaWidth, cssHeight / arenaHeight);
  return {
    scale,
    x: (cssWidth - arenaWidth * scale) / 2,
    y: (cssHeight - arenaHeight * scale) / 2,
    width: arenaWidth,
    height: arenaHeight,
  };
}

export function drawScene(
  ctx: Ctx,
  cssWidth: number,
  cssHeight: number,
  view: WorldView,
  effects: Effects,
  assets: Pick<Assets, "images">,
  arena: ArenaStyle,
  size: { width: number; height: number },
  now = performance.now(),
): void {
  const viewport = arenaViewport(cssWidth, cssHeight, size.width, size.height);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#03080d";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.scale, viewport.scale);
  ctx.beginPath();
  ctx.rect(0, 0, size.width, size.height);
  ctx.clip();
  drawArena(ctx, size.width, size.height, arena);

  for (const pickup of view.pickups) drawPickup(ctx, pickup, now);
  for (const asteroid of view.asteroids)
    drawAsteroid(ctx, asteroid, assets, now);
  for (const ship of view.ships) drawShip(ctx, ship, assets, now);
  for (const bullet of view.bullets) drawBullet(ctx, bullet, assets, now);
  drawParticles(ctx, effects);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(100, 210, 240, 0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    viewport.x,
    viewport.y,
    size.width * viewport.scale,
    size.height * viewport.scale,
  );
  ctx.restore();
}

function drawArena(
  ctx: Ctx,
  width: number,
  height: number,
  arena: ArenaStyle,
): void {
  ctx.save();
  ctx.fillStyle = arena.background ?? "#071019";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = arena.grid ?? "rgba(100, 210, 240, 0.08)";
  ctx.lineWidth = 1;
  const gridSize = arena.gridSize ?? 50;
  // One path and one stroke() for the whole grid: ~50 separate beginPath/stroke
  // pairs per frame showed up in the profile.
  ctx.beginPath();
  for (let x = 0; x <= width; x += gridSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += gridSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSprite(
  ctx: Ctx,
  sprite: LoadedImage | undefined,
  frame: number,
  x: number,
  y: number,
  angle: number,
  size: number,
): boolean {
  if (!sprite) return false;
  const frameWidth = sprite.frameWidth;
  const frameHeight = sprite.frameHeight;
  const frameIndex = Math.abs(frame) % sprite.frames;
  const sx = frameIndex * frameWidth;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(
    sprite.image,
    sx,
    0,
    frameWidth,
    frameHeight,
    -size / 2,
    -size / 2,
    size,
    size,
  );
  ctx.restore();
  return true;
}

function drawShip(
  ctx: Ctx,
  ship: ShipView,
  assets: Pick<Assets, "images">,
  now: number,
): void {
  if (!ship.active) {
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const frame = ship.shield ? (ship.thrust ? 3 : 2) : ship.thrust ? 1 : 0;
  if (
    !drawSprite(
      ctx,
      assets.images.get("ship"),
      frame,
      ship.x,
      ship.y,
      ship.angle,
      64,
    )
  ) {
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.angle);
    ctx.fillStyle = ship.own ? "#d8e5ea" : "#ff9fb0";
    ctx.beginPath();
    ctx.moveTo(22, 0);
    ctx.lineTo(-18, -15);
    ctx.lineTo(-12, 0);
    ctx.lineTo(-18, 15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  if (!ship.own) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 122, 144, 0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (ship.invulnerable && Math.floor(now / 120) % 2 === 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, 32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBullet(
  ctx: Ctx,
  bullet: BulletView,
  assets: Pick<Assets, "images">,
  now: number,
): void {
  const frame = Math.floor(now / 90) % 2;
  if (
    drawSprite(
      ctx,
      assets.images.get("bullet"),
      frame,
      bullet.x,
      bullet.y,
      0,
      24,
    )
  )
    return;
  ctx.save();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(bullet.x, bullet.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAsteroid(
  ctx: Ctx,
  asteroid: AsteroidView,
  assets: Pick<Assets, "images">,
  now: number,
): void {
  const frame = Math.floor(now / 260 + asteroid.id) % 4;
  drawSprite(
    ctx,
    assets.images.get("asteroid"),
    frame,
    asteroid.x,
    asteroid.y,
    asteroid.angle,
    asteroid.radius * 2.35,
  );
  if (asteroid.homing) {
    ctx.save();
    ctx.strokeStyle = "#ff7a90";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(asteroid.x, asteroid.y, asteroid.radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPickup(ctx: Ctx, pickup: PickupView, now: number): void {
  ctx.save();
  ctx.translate(pickup.x, pickup.y);
  ctx.rotate(now / 600);
  ctx.strokeStyle = pickup.pickupType === "shield" ? "#66ffcc" : "#c77dff";
  ctx.lineWidth = 3;
  ctx.strokeRect(-9, -9, 18, 18);
  ctx.restore();
}

/** Particles are drawn without save()/restore() per particle: only alpha changes, and it is reset once. */
function drawParticles(ctx: Ctx, effects: Effects): void {
  if (effects.activeCount === 0) return;
  ctx.fillStyle = "#ff9f43";
  for (const particle of effects.particles) {
    if (!particle.active) continue;
    ctx.globalAlpha = Math.max(0, particle.life / MAX_LIFE);
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
