import { parentPort, workerData } from "node:worker_threads";
import { runScriptedSim } from "./scripted-sim.js";

// A worker is a separate V8 isolate with no `window`/`document`: the sim must run unchanged.
const { hash } = runScriptedSim(workerData);
parentPort.postMessage({
  hash,
  hasDom: typeof document !== "undefined" || typeof window !== "undefined",
});
