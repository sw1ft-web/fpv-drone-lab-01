/**
 * Worker experiment: does moving snapshot DECODING off the main thread pay?
 *
 * Main thread: decode(bytes). Worker: transfer the bytes (zero-copy) to a worker,
 * decode there, post the decoded snapshot back (structured clone: a copy whose cost
 * is proportional to its size). What matters for frames is the MAIN-thread cost
 * per snapshot, so we compare that, plus the added latency of the round trip.
 *
 *   node scripts/bench-worker.ts [--out docs/lab-07/bench-worker.json]
 */
import { writeFile } from "node:fs/promises";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { World, asSeq, asTick, binaryCodec } from "../shared/src/index.ts";

if (!isMainThread) {
  parentPort?.on("message", (bytes: ArrayBuffer) => {
    parentPort?.postMessage(binaryCodec.decodeSnapshot(new Uint8Array(bytes)));
  });
} else {
  const frameFor = (extraAsteroids: number): Uint8Array<ArrayBuffer> => {
    const world = new World({ seed: 5 });
    world.populate();
    for (let i = 0; i < 8; i += 1) world.addShip();
    for (let i = 0; i < extraAsteroids; i += 1) world.step(1 / 60);
    const entities = world.snapshotEntities();
    // Inflate to the requested entity count by repeating (ids need not be unique for a decode benchmark).
    const wanted = Math.max(entities.length, extraAsteroids);
    const many = Array.from(
      { length: wanted },
      (_, i) => entities[i % entities.length],
    ).filter((e) => e !== undefined);
    return binaryCodec.encodeSnapshot({
      tick: asTick(1),
      ack: asSeq(1),
      entities: many,
    });
  };

  const median = (xs: number[]): number =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  const worker = new Worker(new URL(import.meta.url));
  const roundTrip = (bytes: Uint8Array<ArrayBuffer>) =>
    new Promise<{ mainMs: number; latencyMs: number }>((resolve) => {
      const copy = bytes.slice().buffer;
      const sent = performance.now();
      worker.once("message", () => {
        const received = performance.now();
        resolve({ mainMs: 0, latencyMs: received - sent });
      });
      worker.postMessage(copy, [copy]);
    });

  const results = [];
  for (const entityCount of [14, 100, 500, 2000]) {
    const bytes = frameFor(entityCount);
    // Main-thread decode (what the client does today).
    for (let i = 0; i < 2000; i += 1) binaryCodec.decodeSnapshot(bytes);
    const mainDecode: number[] = [];
    for (let run = 0; run < 21; run += 1) {
      const start = performance.now();
      for (let i = 0; i < 500; i += 1) binaryCodec.decodeSnapshot(bytes);
      mainDecode.push((performance.now() - start) / 500);
    }
    // Worker: main-thread cost = postMessage(transfer) + the clone-in on arrival.
    for (let i = 0; i < 200; i += 1) await roundTrip(bytes);
    const latencies: number[] = [];
    const postCost: number[] = [];
    const arrivalCost: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const copy = bytes.slice().buffer;
      const sent = performance.now();
      const done = new Promise<number>((resolve) => {
        worker.once("message", () => resolve(performance.now()));
      });
      const afterPost = (() => {
        worker.postMessage(copy, [copy]);
        return performance.now();
      })();
      postCost.push(afterPost - sent);
      const received = await done;
      latencies.push(received - sent);
      // The clone-in cost is paid inside the 'message' dispatch; approximate it as latency minus pure decode.
      arrivalCost.push(Math.max(0, received - sent - median(mainDecode)));
    }
    results.push({
      entities: entityCount,
      bytes: bytes.byteLength,
      mainThreadDecodeMs: median(mainDecode),
      workerPostMs: median(postCost),
      workerRoundTripMs: median(latencies),
    });
  }
  await worker.terminate();

  console.log(
    "entities | bytes | decode on main (ms) | postMessage on main (ms) | worker round trip (ms)",
  );
  for (const r of results)
    console.log(
      `${String(r.entities).padStart(8)} | ${String(r.bytes).padStart(5)} | ${r.mainThreadDecodeMs.toFixed(4).padStart(19)} | ${r.workerPostMs.toFixed(4).padStart(24)} | ${r.workerRoundTripMs.toFixed(3).padStart(21)}`,
    );
  const out = process.argv.indexOf("--out");
  const target = out >= 0 ? process.argv[out + 1] : undefined;
  if (target)
    await writeFile(
      target,
      `${JSON.stringify({ node: process.version, results }, null, 2)}\n`,
    );
}
