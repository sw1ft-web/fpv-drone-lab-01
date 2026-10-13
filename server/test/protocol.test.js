import assert from "node:assert/strict";
import { test } from "node:test";
import { binaryCodec } from "@fpv/shared/codec";
import { CLOSE, parseClientMessage } from "../src/protocol.js";

const parse = (value) =>
  parseClientMessage(typeof value === "string" ? value : JSON.stringify(value));

test("accepts a valid join and trims the name", () => {
  const result = parse({
    v: 1,
    type: "join",
    roomId: "kyiv-alpha",
    name: "  Denis ",
  });
  assert.deepEqual(result, {
    ok: true,
    message: {
      type: "join",
      roomId: "kyiv-alpha",
      name: "Denis",
      codec: "json",
    },
  });
});

test("accepts chat and leave", () => {
  assert.equal(parse({ v: 1, type: "chat", text: " hi " }).message.text, "hi");
  assert.deepEqual(parse({ v: 1, type: "leave" }), {
    ok: true,
    message: { type: "leave" },
  });
});

test("rejects malformed JSON, non-objects and wrong versions with BAD_MESSAGE", () => {
  for (const raw of [
    "{nope",
    "[]",
    "null",
    "42",
    JSON.stringify({ v: 0, type: "leave" }),
    JSON.stringify({ type: "leave" }),
  ]) {
    const result = parse(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.code, CLOSE.BAD_MESSAGE, raw);
  }
});

test("rejects unknown message types with UNKNOWN_TYPE", () => {
  const result = parse({ v: 1, type: "teleport" });
  assert.equal(result.ok, false);
  assert.equal(result.code, CLOSE.UNKNOWN_TYPE);
});

test("rejects invalid fields", () => {
  const bad = [
    { v: 1, type: "join", roomId: "../etc", name: "x" },
    { v: 1, type: "join", roomId: "ok", name: "" },
    { v: 1, type: "join", roomId: "ok", name: "x".repeat(19) },
    { v: 1, type: "join", roomId: "ok", name: "bad\u0007name" },
    { v: 1, type: "join", roomId: 7, name: "x" },
    { v: 1, type: "chat", text: "   " },
    { v: 1, type: "chat", text: "x".repeat(201) },
    { v: 1, type: "chat", text: 5 },
  ];
  for (const message of bad) {
    const result = parse(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal(result.code, CLOSE.BAD_MESSAGE);
  }
});

test("accepts an input message as JSON text and as a binary frame", () => {
  const inputs = [
    { seq: 10, bits: 5 },
    { seq: 11, bits: 4 },
  ];
  const text = parse({ v: 1, type: "input", inputs });
  assert.deepEqual(text, { ok: true, message: { type: "input", inputs } });
  const binary = parseClientMessage(
    Buffer.from(binaryCodec.encodeInput({ inputs })),
    true,
  );
  assert.deepEqual(binary, { ok: true, message: { type: "input", inputs } });
});

test("rejects malformed input messages and garbage binary frames", () => {
  assert.equal(
    parse({ v: 1, type: "input", inputs: [] }).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parse({ v: 1, type: "input", inputs: [{ seq: 1, bits: 99 }] }).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parse({ v: 1, type: "join", roomId: "ok", name: "x", codec: "zip" }).code,
    CLOSE.BAD_MESSAGE,
  );
  for (const frame of [
    [1, 2, 3],
    [],
    [2, 1, 0, 0, 0, 0, 0, 0],
    [1, 9, 1, 0, 1, 0, 0, 0, 1],
  ]) {
    assert.equal(parseClientMessage(Buffer.from(frame), true).ok, false);
  }
});
