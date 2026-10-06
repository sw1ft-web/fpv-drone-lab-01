export function drawLoadingScreen(
  ctx,
  width,
  height,
  { percent = 0, completed = 0, total = 0, label = "Ready to load", error = "" } = {},
) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#05080d";
  ctx.fillRect(0, 0, width, height);

  const barWidth = Math.min(560, width * 0.68);
  const barHeight = 18;
  const x = (width - barWidth) / 2;
  const y = height * 0.55;

  ctx.textAlign = "center";
  ctx.fillStyle = "#dffcff";
  ctx.font = "700 26px system-ui";
  ctx.fillText("FPV DRONE — LAB 03", width / 2, y - 82);
  ctx.fillStyle = "#7fdff4";
  ctx.font = "14px system-ui";
  ctx.fillText(label, width / 2, y - 44);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(x, y, barWidth, barHeight);
  ctx.fillStyle = "#65e7ff";
  ctx.fillRect(x, y, barWidth * Math.max(0, Math.min(1, percent)), barHeight);
  ctx.strokeStyle = "rgba(130,235,255,0.6)";
  ctx.strokeRect(x, y, barWidth, barHeight);

  ctx.fillStyle = "#a8bac4";
  ctx.font = "13px ui-monospace, monospace";
  ctx.fillText(`${Math.round(percent * 100)}% · ${completed}/${total}`, width / 2, y + 47);

  if (error) {
    ctx.fillStyle = "#ff8d9b";
    ctx.font = "13px system-ui";
    ctx.fillText(error.slice(0, 92), width / 2, y + 82);
  }
  ctx.restore();
}
