import { SNAPSHOT_FLAGS, asEntityId, asSeq, asTick } from "@fpv/shared";
import type { EntityView, Snapshot } from "@fpv/shared";
import type { NetStats } from "../src/net/gameclient.ts";

export type ShipEntity = Extract<EntityView, { kind: "ship" }>;

/** A ship entity with sensible defaults, as the server would send it. */
export const ship = (
  id: number,
  x: number,
  y: number,
  flags: number = SNAPSHOT_FLAGS.ACTIVE,
): ShipEntity => ({
  id: asEntityId(id),
  kind: "ship",
  x,
  y,
  vx: 0,
  vy: 0,
  angle: 0,
  hp: 100,
  score: 0,
  flags,
});

/** A snapshot of `entities` at `tick`, acknowledging input `ack`. */
export const snap = (
  tick: number,
  entities: readonly EntityView[] = [],
  ack = 0,
): Snapshot => ({
  tick: asTick(tick),
  ack: asSeq(ack),
  entities: [...entities],
});

/** A complete NetStats object; tests override only the fields they care about. */
export const netStats = (overrides: Partial<NetStats> = {}): NetStats => ({
  rttMs: 0,
  snapshots: 0,
  snapshotAgeMs: 0,
  lastSnapshotAt: 0,
  correctionPx: 0,
  maxCorrectionPx: 0,
  reconciliations: 0,
  mispredictions: 0,
  teleports: 0,
  inputsSent: 0,
  badFrames: 0,
  bytesIn: 0,
  pendingInputs: 0,
  interpolationDelayMs: 100,
  clockOffsetMs: 0,
  ...overrides,
});
