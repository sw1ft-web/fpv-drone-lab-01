function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

function lerpAngle(a, b, alpha) {
  const twoPi = Math.PI * 2;
  let difference = ((b - a + Math.PI) % twoPi) - Math.PI;
  if (difference < -Math.PI) difference += twoPi;
  return a + difference * alpha;
}

export function drawScene(
  ctx,
  width,
  height,
  world,
  previousShip,
  currentShip,
  alpha,
  assets,
  arena,
  now = performance.now(),
) {
  ctx.clearRect(0, 0, width, height);
  drawArena(ctx, width, height, arena);

  const shipView = currentShip
    ? {
        x: lerp(previousShip.x, currentShip.pos.x, alpha),
        y: lerp(previousShip.y, currentShip.pos.y, alpha),
        angle: lerpAngle(previousShip.angle, currentShip.angle, alpha),
      }
    : null;

  for (const entity of world) {
    if (entity.kind === "ship") drawShip(ctx, entity, shipView, assets);
    if (entity.kind === "bullet") drawBullet(ctx, entity, assets, now);
    if (entity.kind === "asteroid") drawAsteroid(ctx, entity, assets, now);
    if (entity.kind === "pickup") drawPickup(ctx, entity);
    if (entity.kind === "explosion") drawExplosion(ctx, entity);
  }
}

function drawArena(ctx, width, height, arena = {}) {
  ctx.save();
  ctx.fillStyle = arena.background ?? "#071019";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = arena.grid ?? "rgba(100, 210, 240, 0.08)";
  ctx.lineWidth = 1;
  const gridSize = arena.gridSize ?? 50;
  for (let x = 0; x <= width; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.restore();
}

function drawSprite(ctx, sprite, frame, x, y, angle, size) {
  if (!sprite?.image) return false;
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

function drawShip(ctx, entity, interpolated, assets) {
  const view = interpolated ?? entity.pos;
  const angle = interpolated?.angle ?? entity.angle;
  if (!entity.isActive()) {
    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return;
  }

  const frame = entity.shield > 0 ? (entity.thrust ? 3 : 2) : entity.thrust ? 1 : 0;
  if (!drawSprite(ctx, assets.images.get("ship"), frame, view.x, view.y, angle, 64)) {
    ctx.save();
    ctx.translate(view.x, view.y); ctx.rotate(angle);
    ctx.fillStyle = "#d8e5ea";
    ctx.beginPath(); ctx.moveTo(22,0); ctx.lineTo(-18,-15); ctx.lineTo(-12,0); ctx.lineTo(-18,15); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  if (entity.invulnerable > 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath(); ctx.arc(entity.pos.x, entity.pos.y, entity.radius + 8, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function drawBullet(ctx, bullet, assets, now) {
  const frame = Math.floor(now / 90) % 2;
  if (drawSprite(ctx, assets.images.get("bullet"), frame, bullet.pos.x, bullet.pos.y, 0, 24)) return;
  ctx.save(); ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(bullet.pos.x, bullet.pos.y, bullet.radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function drawAsteroid(ctx, asteroid, assets, now) {
  const frame = Math.floor(now / 260 + asteroid.id) % 4;
  if (drawSprite(ctx, assets.images.get("asteroid"), frame, asteroid.pos.x, asteroid.pos.y, asteroid.angle, asteroid.radius * 2.35)) {
    if (asteroid.homing) {
      ctx.save(); ctx.strokeStyle = "#ff7a90"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(asteroid.pos.x, asteroid.pos.y, asteroid.radius + 5, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    return;
  }
}

function drawPickup(ctx, pickup) {
  ctx.save();
  ctx.translate(pickup.pos.x, pickup.pos.y); ctx.rotate(pickup.phase);
  ctx.strokeStyle = pickup.pickupType === "shield" ? "#66ffcc" : "#c77dff";
  ctx.lineWidth = 3; ctx.strokeRect(-9, -9, 18, 18); ctx.restore();
}

function drawExplosion(ctx, explosion) {
  for (const particle of explosion.particles) {
    if (particle.life <= 0) continue;
    ctx.save(); ctx.globalAlpha = Math.max(0, particle.life / 0.65); ctx.fillStyle = "#ff9f43";
    ctx.beginPath(); ctx.arc(particle.pos.x, particle.pos.y, particle.size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

export { lerp, lerpAngle };
