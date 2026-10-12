import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "./helpers.js";

const entry = new URL("../src/index.js", import.meta.url).pathname;

function startChild(env) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => (output += chunk));
  const listening = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output
        .split("\n")
        .find((entryLine) => entryLine.includes("server listening"));
      if (line) resolve(JSON.parse(line).port);
    });
    child.once("exit", (code) =>
      reject(new Error(`server exited early (${code}): ${output}`)),
    );
  });
  listening.catch(() => {}); // callers that never await it must not trigger an unhandled rejection
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, listening, exited, output: () => output };
}

test("SIGTERM: closes sockets with 1001, flushes the match log and exits 0", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "fpv-shutdown-"));
  const { child, listening, exited } = startChild({
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: logDir,
  });
  try {
    const port = await listening;
    const client = await connect(`ws://127.0.0.1:${port}/ws`);
    client.send({ type: "join", roomId: "kyiv-alpha", name: "Ann" });
    await client.waitFor((message) => message.type === "welcome");

    child.kill("SIGTERM");
    const closed = await client.waitForClose(3000);
    assert.equal(closed.code, 1001);

    const result = await exited;
    assert.equal(result.code, 0);

    const [file] = await readdir(logDir);
    const lines = (await readFile(join(logDir, file), "utf8"))
      .trim()
      .split("\n");
    assert.equal(JSON.parse(lines[0]).type, "join");
  } finally {
    child.kill("SIGKILL");
    await rm(logDir, { recursive: true, force: true });
  }
});

test("invalid configuration makes the process exit with a clear message", async () => {
  const { exited, output } = startChild({ PORT: "not-a-number" });
  const result = await exited;
  assert.equal(result.code, 1);
  assert.match(output(), /PORT must be an integer/);
});
