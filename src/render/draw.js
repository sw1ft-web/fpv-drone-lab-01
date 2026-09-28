function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

function lerpAngle(a, b, alpha) {
  const twoPi = Math.PI * 2;
  let difference = ((b - a + Math.PI) % twoPi) - Math.PI;
  if (difference < -Math.PI) difference += twoPi;
  return a + difference * alpha;
}

export function drawScene(ctx, width, height, world, previousShip, currentShip, alpha) {
  ctx.clearRect(0, 0, width, height);
  drawArena(ctx, width, height);

  const ship = currentShip
    ? {
        x: lerp(previousShip.x, currentShip.pos.x, alpha),
        y: lerp(previousShip.y, currentShip.pos.y, alpha),
        angle: lerpAngle(previousShip.angle, currentShip.angle, alpha),
      }
    : null;

  for (const entity of world) {
    if (entity.kind === "ship") drawShip(ctx, entity, ship);
    if (entity.kind === "bullet") drawBullet(ctx, entity);
    if (entity.kind === "asteroid") drawAsteroid(ctx, entity);
    if (entity.kind === "pickup") drawPickup(ctx, entity);
    if (entity.kind === "explosion") drawExplosion(ctx, entity);
  }
}

function drawArena(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = "#071019";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(100, 210, 240, 0.08)";
  ctx.lineWidth = 1;

  for (let x = 0; x <= width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = 0; y <= height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShip(ctx, entity, interpolated) {
  const view = entity === entity && interpolated ? interpolated : entity.pos;
  const angle = interpolated ? interpolated.angle : entity.angle;

  if (!entity.isActive()) {
    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.rotate(angle);

  if (entity.thrust) {
    ctx.beginPath();
    ctx.moveTo(-17, -6);
    ctx.lineTo(-35, 0);
    ctx.lineTo(-17, 6);
    ctx.closePath();
    ctx.fillStyle = "#ff9f43";
    ctx.fill();
  }

  ctx.fillStyle = "#d8e5ea";
  ctx.strokeStyle = entity.shield > 0 ? "#66ffcc" : "#64e7ff";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(-10, -10);
  ctx.lineTo(-17, -24);
  ctx.lineTo(-24, -22);
  ctx.lineTo(-18, -7);
  ctx.lineTo(-18, 7);
  ctx.lineTo(-24, 22);
  ctx.lineTo(-17, 24);
  ctx.lineTo(-10, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(14, 0, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#071019";
  ctx.fill();
  ctx.stroke();

  ctx.restore();

  if (entity.invulnerable > 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(entity.pos.x, entity.pos.y, entity.radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBullet(ctx, bullet) {
  ctx.save();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(bullet.pos.x, bullet.pos.y, bullet.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAsteroid(ctx, asteroid) {
  ctx.save();
  ctx.translate(asteroid.pos.x, asteroid.pos.y);
  ctx.rotate(asteroid.angle);
  ctx.strokeStyle = asteroid.homing ? "#ff7a90" : "#9aa7b0";
  ctx.fillStyle = "#26313a";
  ctx.lineWidth = 2;

  ctx.beginPath();
  const points = 9;
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const r = asteroid.radius * (0.75 + ((i * 17) % 31) / 100);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPickup(ctx, pickup) {
  ctx.save();
  ctx.translate(pickup.pos.x, pickup.pos.y);
  ctx.rotate(pickup.phase);
  ctx.strokeStyle = pickup.pickupType === "shield" ? "#66ffcc" : "#c77dff";
  ctx.lineWidth = 3;
  ctx.strokeRect(-9, -9, 18, 18);
  ctx.restore();
}

function drawExplosion(ctx, explosion) {
  for (const particle of explosion.particles) {
    if (particle.life <= 0) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, particle.life / 0.65);
    ctx.fillStyle = "#ff9f43";
    ctx.beginPath();
    ctx.arc(particle.pos.x, particle.pos.y, particle.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export { lerp, lerpAngle };
