import { parentPort, workerData } from "node:worker_threads";
import { runScriptedSim } from "./scripted-sim.ts";
import type { ScriptedSimOptions } from "./scripted-sim.ts";

if (!parentPort) throw new Error("worker.ts must run inside a worker thread");

// A worker is a separate V8 isolate with no `window`/`document`: the sim must run unchanged.
// workerData is structured-cloned from the parent, which builds it as ScriptedSimOptions.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const options: ScriptedSimOptions = workerData;
const { hash } = runScriptedSim(options);
parentPort.postMessage({
  hash,
  hasDom: typeof document !== "undefined" || typeof window !== "undefined",
});
