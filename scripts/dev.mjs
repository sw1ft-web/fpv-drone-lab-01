// Starts the game server and the Vite dev server together (no extra dependency).
import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev", "-w", "server"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "client"], { stdio: "inherit" }),
];

function stop(signal) {
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
for (const child of children) {
  child.on("exit", (code) => {
    stop("SIGTERM");
    process.exitCode = code ?? 0;
  });
}
