import assert from "node:assert/strict";
import { test } from "node:test";
import { binaryCodec } from "@fpv/shared/codec";
import { asSeq } from "@fpv/shared";
import { CLOSE, parseClientMessage } from "../src/protocol.ts";
import type { ParsedFrame } from "../src/protocol.ts";

const parse = (value: unknown): ParsedFrame =>
  parseClientMessage(
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  );

/** The code of a rejected frame; fails the test if the frame was accepted. */
const codeOf = (frame: ParsedFrame): number => {
  assert.equal(frame.ok, false);
  return frame.code;
};

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
      v: 1,
      type: "join",
      roomId: "kyiv-alpha",
      name: "Denis",
      codec: "json",
    },
  });
});

test("accepts chat and leave", () => {
  const chat = parse({ v: 1, type: "chat", text: " hi " });
  assert.deepEqual(chat, {
    ok: true,
    message: { v: 1, type: "chat", text: "hi" },
  });
  assert.deepEqual(parse({ v: 1, type: "leave" }), {
    ok: true,
    message: { v: 1, type: "leave" },
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
    assert.equal(codeOf(parse(raw)), CLOSE.BAD_MESSAGE, raw);
  }
});

test("rejects unknown message types with UNKNOWN_TYPE", () => {
  assert.equal(codeOf(parse({ v: 1, type: "teleport" })), CLOSE.UNKNOWN_TYPE);
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
    assert.equal(
      codeOf(parse(message)),
      CLOSE.BAD_MESSAGE,
      JSON.stringify(message),
    );
  }
});

test("accepts an input message as JSON text and as a binary frame", () => {
  const inputs = [
    { seq: asSeq(10), bits: 5 },
    { seq: asSeq(11), bits: 4 },
  ];
  const text = parse({ v: 1, type: "input", inputs });
  assert.deepEqual(text, {
    ok: true,
    message: { v: 1, type: "input", inputs },
  });
  const binary = parseClientMessage(
    Buffer.from(binaryCodec.encodeInput({ inputs })),
    true,
  );
  assert.deepEqual(binary, {
    ok: true,
    message: { v: 1, type: "input", inputs },
  });
});

test("rejects malformed input messages and garbage binary frames", () => {
  assert.equal(
    codeOf(parse({ v: 1, type: "input", inputs: [] })),
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    codeOf(parse({ v: 1, type: "input", inputs: [{ seq: 1, bits: 99 }] })),
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    codeOf(
      parse({ v: 1, type: "join", roomId: "ok", name: "x", codec: "zip" }),
    ),
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
