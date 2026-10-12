import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE, parseClientMessage } from "../src/protocol.js";

const parse = (value) =>
  parseClientMessage(typeof value === "string" ? value : JSON.stringify(value));

test("accepts a valid join and trims the name", () => {
  const result = parse({
    v: 0,
    type: "join",
    roomId: "kyiv-alpha",
    name: "  Denis ",
  });
  assert.deepEqual(result, {
    ok: true,
    message: { type: "join", roomId: "kyiv-alpha", name: "Denis" },
  });
});

test("accepts chat and leave", () => {
  assert.equal(parse({ v: 0, type: "chat", text: " hi " }).message.text, "hi");
  assert.deepEqual(parse({ v: 0, type: "leave" }), {
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
    JSON.stringify({ v: 1, type: "leave" }),
    JSON.stringify({ type: "leave" }),
  ]) {
    const result = parse(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.code, CLOSE.BAD_MESSAGE, raw);
  }
});

test("rejects unknown message types with UNKNOWN_TYPE", () => {
  const result = parse({ v: 0, type: "teleport" });
  assert.equal(result.ok, false);
  assert.equal(result.code, CLOSE.UNKNOWN_TYPE);
});

test("rejects invalid fields", () => {
  const bad = [
    { v: 0, type: "join", roomId: "../etc", name: "x" },
    { v: 0, type: "join", roomId: "ok", name: "" },
    { v: 0, type: "join", roomId: "ok", name: "x".repeat(19) },
    { v: 0, type: "join", roomId: "ok", name: "bad\u0007name" },
    { v: 0, type: "join", roomId: 7, name: "x" },
    { v: 0, type: "chat", text: "   " },
    { v: 0, type: "chat", text: "x".repeat(201) },
    { v: 0, type: "chat", text: 5 },
  ];
  for (const message of bad) {
    const result = parse(message);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal(result.code, CLOSE.BAD_MESSAGE);
  }
});

test("rejects binary frames", () => {
  assert.equal(parseClientMessage(Buffer.from([1, 2, 3]), true).ok, false);
});
