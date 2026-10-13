import assert from "node:assert/strict";
import { test } from "vitest";
import { TAU } from "../src/constants.ts";
import {
  CodecError,
  binaryCodec,
  dequantizeAngle,
  jsonCodec,
  quantizeAngle,
  snapshotByteLength,
} from "../src/codec/index.ts";
import { World, asSeq, asTick } from "../src/index.ts";
import type { Snapshot } from "../src/index.ts";

const sampleSnapshot = (): Snapshot => {
  const world = new World({ seed: 11 });
  world.populate();
  world.addShip();
  return {
    tick: asTick(1234),
    ack: asSeq(99),
    entities: world.snapshotEntities(),
  };
};
const angleDiff = (a: number, b: number): number =>
  Math.abs(((((a - b + Math.PI) % TAU) + TAU) % TAU) - Math.PI);

test("JSON snapshot round-trips exactly", () => {
  const snapshot = sampleSnapshot();
  const decoded = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snapshot));
  assert.deepEqual(decoded, { type: "snapshot", ...snapshot });
});

test("binary snapshot round-trips within quantisation tolerance", () => {
  const snapshot = sampleSnapshot();
  const decoded = binaryCodec.decodeSnapshot(
    binaryCodec.encodeSnapshot(snapshot),
  );
  assert.equal(decoded.tick, snapshot.tick);
  assert.equal(decoded.ack, snapshot.ack);
  assert.equal(decoded.entities.length, snapshot.entities.length);
  snapshot.entities.forEach((entity, index) => {
    const got = decoded.entities[index];
    assert.ok(got);
    assert.equal(got.id, entity.id);
    assert.equal(got.kind, entity.kind);
    for (const key of ["x", "y", "vx", "vy"] as const)
      assert.ok(Math.abs(got[key] - entity[key]) < 1e-3, key);
    assert.ok(angleDiff(got.angle, entity.angle) <= TAU / 65536, "angle");
    if (entity.kind === "ship" && got.kind === "ship")
      assert.deepEqual(
        [got.hp, got.score, got.flags],
        [entity.hp, entity.score, entity.flags],
      );
    if (entity.kind === "asteroid" && got.kind === "asteroid")
      assert.equal(got.homing, entity.homing);
  });
});

test("binary snapshot size matches snapshotByteLength and is much smaller than JSON", () => {
  const snapshot = sampleSnapshot();
  const binary = binaryCodec.encodeSnapshot(snapshot);
  assert.equal(binary.length, snapshotByteLength(snapshot.entities));
  assert.ok(binary.length * 4 < jsonCodec.encodeSnapshot(snapshot).length);
});

test("input frames round-trip in both codecs", () => {
  const message = {
    inputs: [
      { seq: asSeq(4_000_000_000), bits: 5 },
      { seq: asSeq(4_000_000_001), bits: 0 },
      { seq: asSeq(4_000_000_002), bits: 31 },
    ],
  };
  const expected = { type: "input", ...message };
  assert.deepEqual(
    binaryCodec.decodeInput(binaryCodec.encodeInput(message)),
    expected,
  );
  assert.deepEqual(
    jsonCodec.decodeInput(jsonCodec.encodeInput(message)),
    expected,
  );
  assert.equal(binaryCodec.encodeInput(message).length, 8 + 3);
});

test("angle quantisation error is at most half a step and wraps", () => {
  for (let i = 0; i < 2000; i += 1) {
    const angle = (i / 2000) * TAU * 3 - TAU;
    const back = dequantizeAngle(quantizeAngle(angle));
    assert.ok(angleDiff(back, angle) <= TAU / 65536 / 2 + 1e-12);
  }
});

test("binary decoders reject truncated, trailing, unknown and out-of-range data", () => {
  const good = binaryCodec.encodeSnapshot(sampleSnapshot());
  const goodInput = binaryCodec.encodeInput({
    inputs: [{ seq: asSeq(1), bits: 1 }],
  });
  const cases = [
    () => binaryCodec.decodeSnapshot(good.slice(0, 5)),
    () => binaryCodec.decodeSnapshot(good.slice(0, good.length - 1)),
    () => binaryCodec.decodeSnapshot(Uint8Array.from([...good, 0])),
    () =>
      binaryCodec.decodeSnapshot(
        Uint8Array.from([...good].map((byte, i) => (i === 1 ? 9 : byte))),
      ),
    () =>
      binaryCodec.decodeSnapshot(
        Uint8Array.from([...good].map((byte, i) => (i === 0 ? 7 : byte))),
      ),
    () =>
      binaryCodec.decodeSnapshot(
        Uint8Array.from([...good].map((byte, i) => (i === 12 + 4 ? 99 : byte))),
      ),
    () => binaryCodec.decodeInput(goodInput.slice(0, 7)),
    () =>
      binaryCodec.decodeInput(
        Uint8Array.from(
          [...goodInput].map((byte, i) => (i === 8 ? 0xff : byte)),
        ),
      ),
    () =>
      binaryCodec.decodeInput(
        Uint8Array.from([...goodInput].map((byte, i) => (i === 2 ? 0 : byte))),
      ),
    () =>
      binaryCodec.decodeInput(
        Uint8Array.from(
          [...goodInput].map((byte, i) => (i === 2 ? 200 : byte)),
        ),
      ),
    // @ts-expect-error a string is not binary data: the decoder must still refuse it at runtime
    () => binaryCodec.decodeSnapshot("not binary"),
  ];
  for (const run of cases) assert.throws(run, CodecError);
});

test("JSON decoders reject malformed input", () => {
  for (const raw of [
    "{nope",
    "[]",
    '{"v":0,"type":"input"}',
    '{"v":1,"type":"input","inputs":[]}',
    '{"v":1,"type":"input","inputs":[{"seq":1,"bits":99}]}',
    '{"v":1,"type":"input","inputs":[{"seq":1,"bits":1},{"seq":5,"bits":1}]}',
  ]) {
    assert.throws(() => jsonCodec.decodeInput(raw), CodecError, raw);
  }
  assert.throws(
    () =>
      jsonCodec.decodeSnapshot(
        '{"v":1,"type":"snapshot","tick":1,"ack":1,"entities":[{"id":1,"kind":"ufo"}]}',
      ),
    CodecError,
  );
});

test("encoders refuse non-contiguous input sequences", () => {
  assert.throws(
    () =>
      binaryCodec.encodeInput({
        inputs: [
          { seq: asSeq(1), bits: 0 },
          { seq: asSeq(3), bits: 0 },
        ],
      }),
    CodecError,
  );
});
