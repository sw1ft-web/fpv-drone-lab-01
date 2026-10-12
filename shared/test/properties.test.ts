import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import {
  CodecError,
  PROTOCOL_VERSION,
  SIM_STEP,
  World,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  commandFromBits,
  commandToBits,
  parseClientMessage,
  snapshotByteLength,
  COMMAND_MASK,
} from "../src/index.ts";
import type { EntityView } from "../src/index.ts";

const coord = (max: number) => fc.double({ min: 0, max, noNaN: true });
const velocity = fc.double({ min: -600, max: 600, noNaN: true });
const angle = fc.double({ min: 0, max: Math.PI * 2 - 1e-6, noNaN: true });
const u8 = fc.integer({ min: 0, max: 255 });

const shipView: fc.Arbitrary<EntityView> = fc.record({
  id: fc.integer({ min: 1, max: 60000 }).map(asEntityId),
  kind: fc.constant("ship" as const),
  x: coord(1600),
  y: coord(900),
  vx: velocity,
  vy: velocity,
  angle,
  hp: fc.integer({ min: 0, max: 100 }),
  score: fc.integer({ min: 0, max: 60000 }),
  flags: fc.integer({ min: 0, max: 31 }),
});
const asteroidView: fc.Arbitrary<EntityView> = fc.record({
  id: fc.integer({ min: 1, max: 60000 }).map(asEntityId),
  kind: fc.constant("asteroid" as const),
  x: coord(1600),
  y: coord(900),
  vx: velocity,
  vy: velocity,
  angle,
  radius: fc.integer({ min: 10, max: 60 }),
  homing: fc.constantFrom(0, 1),
});
const bulletView: fc.Arbitrary<EntityView> = fc.record({
  id: fc.integer({ min: 1, max: 60000 }).map(asEntityId),
  kind: fc.constant("bullet" as const),
  x: coord(1600),
  y: coord(900),
  vx: velocity,
  vy: velocity,
  angle,
  ownerId: fc.integer({ min: 1, max: 60000 }).map(asEntityId),
  fireSeq: fc.integer({ min: 0, max: 1_000_000 }).map(asSeq),
});
const entities = fc.array(fc.oneof(shipView, asteroidView, bulletView), {
  maxLength: 40,
});
const snapshotArb = fc.record({
  tick: fc.integer({ min: 0, max: 1_000_000 }).map(asTick),
  ack: fc.integer({ min: 0, max: 1_000_000 }).map(asSeq),
  entities,
});

describe("properties (fast-check)", () => {
  test("binary snapshot round-trips within quantisation tolerance", () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const decoded = binaryCodec.decodeSnapshot(
          binaryCodec.encodeSnapshot(snapshot),
        );
        assert.equal(decoded.tick, snapshot.tick);
        assert.equal(decoded.ack, snapshot.ack);
        assert.equal(decoded.entities.length, snapshot.entities.length);
        snapshot.entities.forEach((entity, i) => {
          const got = decoded.entities[i];
          assert.ok(got);
          assert.equal(got.id, entity.id);
          assert.equal(got.kind, entity.kind);
          assert.ok(Math.abs(got.x - entity.x) < 0.01);
          assert.ok(Math.abs(got.y - entity.y) < 0.01);
        });
      }),
      { numRuns: 200 },
    );
  });

  test("encoded length always equals snapshotByteLength", () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        assert.equal(
          binaryCodec.encodeSnapshot(snapshot).byteLength,
          snapshotByteLength(snapshot.entities),
        );
      }),
    );
  });

  test("random bytes either decode or throw CodecError, never anything else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        for (const decode of [
          binaryCodec.decodeSnapshot,
          binaryCodec.decodeInput,
        ]) {
          try {
            decode(bytes);
          } catch (error) {
            assert.ok(error instanceof CodecError, String(error));
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test("mutating one byte of a valid frame never crashes the decoder", () => {
    fc.assert(
      fc.property(snapshotArb, fc.nat(), u8, (snapshot, position, value) => {
        const frame = binaryCodec.encodeSnapshot(snapshot).slice();
        frame[position % frame.length] = value;
        try {
          binaryCodec.decodeSnapshot(frame);
        } catch (error) {
          assert.ok(error instanceof CodecError, String(error));
        }
      }),
    );
  });

  test("command bits round-trip", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: COMMAND_MASK }), (bits) => {
        assert.equal(commandToBits(commandFromBits(bits)), bits);
      }),
    );
  });

  test("ships stay inside the arena for any sequence of commands", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 }),
        fc.array(fc.integer({ min: 0, max: COMMAND_MASK }), {
          minLength: 1,
          maxLength: 40,
        }),
        (seed, script) => {
          const world = new World({ seed });
          const ship = world.addShip();
          for (let step = 0; step < 1000; step += 1) {
            const bits = script[step % script.length] ?? 0;
            world.step(
              SIM_STEP,
              new Map([
                [ship.id, { ...commandFromBits(bits), seq: asSeq(step + 1) }],
              ]),
            );
            assert.ok(ship.pos.x >= 0 && ship.pos.x <= world.width);
            assert.ok(ship.pos.y >= 0 && ship.pos.y <= world.height);
            assert.ok(Number.isFinite(ship.vel.x + ship.vel.y));
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  test("parseClientMessage accepts every valid input message (contiguous seqs)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: COMMAND_MASK }), {
          minLength: 1,
          maxLength: 16,
        }),
        (first, bits) => {
          const inputs = bits.map((b, i) => ({ seq: first + i, bits: b }));
          const result = parseClientMessage({
            v: PROTOCOL_VERSION,
            type: "input",
            inputs,
          });
          assert.equal(result.ok, true);
        },
      ),
    );
  });

  test("parseClientMessage rejects input with a gap in the sequence", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 50 }),
        (first, gap) => {
          const result = parseClientMessage({
            v: PROTOCOL_VERSION,
            type: "input",
            inputs: [
              { seq: first, bits: 0 },
              { seq: first + gap, bits: 0 },
            ],
          });
          assert.equal(result.ok, false);
        },
      ),
    );
  });

  test("parseClientMessage never throws and rejects anything without the right version", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseClientMessage(value);
        if (result.ok) {
          assert.ok(
            typeof value === "object" &&
              value !== null &&
              "v" in value &&
              value.v === PROTOCOL_VERSION,
          );
        }
      }),
      { numRuns: 500 },
    );
  });
});
