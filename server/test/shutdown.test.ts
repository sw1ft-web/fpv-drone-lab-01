import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { z } from "zod";
import { connect } from "./helpers.ts";

const Port = z.object({ port: z.number() });
const Typed = z.object({ type: z.string() });

const entry = new URL("../src/index.ts", import.meta.url).pathname;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function startChild(env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const listening = new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output
        .split("\n")
        .find((entryLine) => entryLine.includes("server listening"));
      if (line) resolve(Port.parse(JSON.parse(line)).port);
    });
    child.once("exit", (code) =>
      reject(new Error(`server exited early (${code}): ${output}`)),
    );
  });
  listening.catch(() => {}); // callers that never await it must not trigger an unhandled rejection
  const exited = new Promise<ChildResult>((resolve) =>
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
    await client.waitForType("welcome");

    child.kill("SIGTERM");
    const closed = await client.waitForClose(3000);
    assert.equal(closed.code, 1001);

    const result = await exited;
    assert.equal(result.code, 0);

    const [file] = await readdir(logDir);
    assert.ok(file);
    const lines = (await readFile(join(logDir, file), "utf8"))
      .trim()
      .split("\n");
    assert.equal(Typed.parse(JSON.parse(lines[0] ?? "null")).type, "join");
  } finally {
    child.kill("SIGKILL");
    await rm(logDir, { recursive: true, force: true });
  }
});

test("invalid configuration makes the process exit with a clear message", async () => {
  const { exited, output } = startChild({ PORT: "not-a-number" });
  const result = await exited;
  assert.equal(result.code, 1);
  assert.match(output(), /PORT.*must be an integer/);
});
