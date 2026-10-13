import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import {
  SIM_STEP,
  asEntityId,
  commandFromBits,
  COMMAND_MASK,
  integrateShip,
} from "@fpv/shared";
import type { ShipKinematic } from "@fpv/shared";
import { GameClient } from "../src/net/gameclient.ts";
import { wrapDelta } from "../src/net/interpolation.ts";
import { ship, snap } from "./fixtures.ts";

describe("properties (fast-check)", () => {
  test("wrapDelta is the shortest signed distance on a ring", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1600, noNaN: true }),
        fc.double({ min: 0, max: 1600, noNaN: true }),
        (a, b) => {
          const d = wrapDelta(a, b, 1600);
          assert.ok(Math.abs(d) <= 800 + 1e-9);
          // Moving by d from a lands on b (mod the ring).
          const landed = (((a + d) % 1600) + 1600) % 1600;
          const diff = Math.abs(landed - b);
          assert.ok(Math.min(diff, 1600 - diff) < 1e-6);
        },
      ),
    );
  });

  test("wrapDelta is antisymmetric", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 900, noNaN: true }),
        fc.double({ min: 0, max: 900, noNaN: true }),
        (a, b) => {
          const forward = wrapDelta(a, b, 900);
          const back = wrapDelta(b, a, 900);
          // At exactly half the ring both directions are equally short.
          if (Math.abs(Math.abs(forward) - 450) > 1e-9)
            assert.ok(Math.abs(forward + back) < 1e-9);
        },
      ),
    );
  });

  test("a server that applies the same inputs never causes a misprediction, whatever the inputs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: COMMAND_MASK & ~16 }), {
          minLength: 5,
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 4 }),
        (script, lag) => {
          let now = 0;
          const client = new GameClient({
            welcome: {
              shipId: asEntityId(1),
              codec: "json",
              arena: { width: 1600, height: 900 },
            },
            now: () => now,
            send: () => {},
          });
          const server: ShipKinematic = {
            pos: { x: 400, y: 300 },
            vel: { x: 0, y: 0 },
            angle: 0,
            thrust: 0,
          };
          client.ingest(snap(1, [ship(1, 400, 300)], 0));
          script.forEach((bits) => client.step(bits));
          // The server has applied all but the last `lag` inputs.
          const applied = Math.max(0, script.length - lag);
          for (const bits of script.slice(0, applied))
            integrateShip(server, commandFromBits(bits), SIM_STEP, 1600, 900);
          now += 50;
          client.ingest(
            snap(
              2,
              [
                {
                  ...ship(1, server.pos.x, server.pos.y),
                  vx: server.vel.x,
                  vy: server.vel.y,
                  angle: server.angle,
                },
              ],
              applied,
            ),
          );
          assert.equal(client.stats.mispredictions, 0);
          assert.equal(client.pending.length, script.length - applied);
        },
      ),
      { numRuns: 100 },
    );
  });
});
