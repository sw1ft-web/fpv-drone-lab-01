import { SNAPSHOT_FLAGS, TAU } from "../constants.ts";
import { MAX_INPUTS_PER_MESSAGE } from "../protocol/constants.ts";
import { COMMAND_MASK } from "../sim/command.ts";
import { asEntityId, asSeq, asTick, assertNever } from "../types.ts";
import type {
  EntityKind,
  EntityView,
  InputEntry,
  Seq,
  Snapshot,
} from "../types.ts";
import { CodecError } from "./errors.ts";

/**
 * Binary wire format, version 1. Everything is little-endian.
 * The full byte-level specification lives in docs/lab-05.md ("Binary protocol").
 *
 *   input frame     : u8 type=1 | u8 version | u8 count | u8 reserved | u32 firstSeq | u8 bits[count]
 *   snapshot frame  : u8 type=2 | u8 version | u16 entityCount | u32 tick | u32 ack | entity[entityCount]
 *   entity common   : u32 id | u8 kind | u8 flags | f32 x | f32 y | f32 vx | f32 vy | u16 angle
 *   + ship          : u8 hp | u16 score
 *   + bullet        : u32 ownerId | u32 fireSeq
 *   + asteroid      : u8 radius           (flags bit0 = homing)
 *   + pickup        : -                   (flags bit0 = type: 0 shield, 1 rapid-fire)
 *
 * `angle` is quantised to 1/65536 of a turn (about 0.0055 degrees).
 */
export const BINARY_VERSION = 1;
export const FRAME_TYPE = Object.freeze({ INPUT: 1, SNAPSHOT: 2 });
export const MAX_ENTITIES = 2048;

/** Anything a WebSocket can hand us for a binary frame. */
export type BinaryData = Uint8Array | ArrayBuffer | ArrayBufferView;

const KIND_CODE: Readonly<Record<EntityKind, number>> = {
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
};
/** Bytes that follow the 24-byte common part, by kind code (index 0 is unused). */
const EXTRA_SIZE = [0, 3, 8, 1, 0] as const;
const COMMON_SIZE = 24;
const HEADER_SIZE = 12;
const INPUT_HEADER_SIZE = 8;
const U32_MAX = 0xffffffff;

const KNOWN_SHIP_FLAGS =
  SNAPSHOT_FLAGS.ACTIVE |
  SNAPSHOT_FLAGS.INVULNERABLE |
  SNAPSHOT_FLAGS.SHIELD |
  SNAPSHOT_FLAGS.RAPID_FIRE |
  SNAPSHOT_FLAGS.THRUST;

const extraSize = (kindCode: number): number => EXTRA_SIZE[kindCode] ?? 0;

const toBytes = (data: BinaryData): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError("expected binary data");
};

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function quantizeAngle(angle: number): number {
  return Math.round(((((angle % TAU) + TAU) % TAU) / TAU) * 65536) & 0xffff;
}
export const dequantizeAngle = (value: number): number => (value / 65536) * TAU;

/** First byte of a binary frame, or -1 for an empty buffer. */
export function peekFrameType(data: BinaryData): number {
  const bytes = toBytes(data);
  return bytes[0] ?? -1;
}

export interface DecodedInput {
  readonly type: "input";
  readonly inputs: InputEntry[];
}

export function encodeInput({
  inputs,
}: {
  readonly inputs: readonly InputEntry[];
}): Uint8Array<ArrayBuffer> {
  const count = inputs.length;
  const first = inputs[0];
  if (!first || count > MAX_INPUTS_PER_MESSAGE)
    throw new CodecError(`input count ${count} out of range`);
  const firstSeq = first.seq;
  const bytes = new Uint8Array(INPUT_HEADER_SIZE + count);
  const view = viewOf(bytes);
  view.setUint8(0, FRAME_TYPE.INPUT);
  view.setUint8(1, BINARY_VERSION);
  view.setUint8(2, count);
  view.setUint32(4, firstSeq, true);
  inputs.forEach((input, index) => {
    if (input.seq !== firstSeq + index)
      throw new CodecError("input sequence numbers must be contiguous");
    if ((input.bits & ~COMMAND_MASK) !== 0)
      throw new CodecError("input bits out of range");
    view.setUint8(INPUT_HEADER_SIZE + index, input.bits);
  });
  return bytes;
}

export function decodeInput(data: BinaryData): DecodedInput {
  const bytes = toBytes(data);
  if (bytes.length < INPUT_HEADER_SIZE)
    throw new CodecError("input frame too short");
  const view = viewOf(bytes);
  if (view.getUint8(0) !== FRAME_TYPE.INPUT)
    throw new CodecError("not an input frame");
  if (view.getUint8(1) !== BINARY_VERSION)
    throw new CodecError(`unsupported binary version ${view.getUint8(1)}`);
  const count = view.getUint8(2);
  if (count < 1 || count > MAX_INPUTS_PER_MESSAGE)
    throw new CodecError(`input count ${count} out of range`);
  if (bytes.length !== INPUT_HEADER_SIZE + count)
    throw new CodecError("input frame length mismatch");
  const firstSeq = view.getUint32(4, true);
  if (firstSeq + count - 1 > U32_MAX)
    throw new CodecError("sequence number overflow");

  const inputs: InputEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const bits = view.getUint8(INPUT_HEADER_SIZE + index);
    if ((bits & ~COMMAND_MASK) !== 0)
      throw new CodecError("input bits out of range");
    inputs.push({ seq: asSeq(firstSeq + index), bits });
  }
  return { type: "input", inputs };
}

export function snapshotByteLength(entities: readonly EntityView[]): number {
  let size = HEADER_SIZE;
  for (const entity of entities)
    size += COMMON_SIZE + extraSize(KIND_CODE[entity.kind]);
  return size;
}

const clampByte = (value: number): number =>
  Math.min(255, Math.max(0, Math.round(value)));

export function encodeSnapshot({
  tick,
  ack,
  entities,
}: Snapshot): Uint8Array<ArrayBuffer> {
  if (entities.length > MAX_ENTITIES) throw new CodecError("too many entities");
  const bytes = new Uint8Array(snapshotByteLength(entities));
  const view = viewOf(bytes);
  view.setUint8(0, FRAME_TYPE.SNAPSHOT);
  view.setUint8(1, BINARY_VERSION);
  view.setUint16(2, entities.length, true);
  view.setUint32(4, tick >>> 0, true);
  view.setUint32(8, ack >>> 0, true);

  let offset = HEADER_SIZE;
  for (const entity of entities) {
    const kind = KIND_CODE[entity.kind];
    let flags = 0;
    switch (entity.kind) {
      case "ship":
        flags = entity.flags;
        break;
      case "asteroid":
        flags = entity.homing;
        break;
      case "pickup":
        flags = entity.pickupType;
        break;
      case "bullet":
        break;
      default:
        return assertNever(entity, "unknown entity kind");
    }

    view.setUint32(offset, entity.id, true);
    view.setUint8(offset + 4, kind);
    view.setUint8(offset + 5, flags);
    view.setFloat32(offset + 6, entity.x, true);
    view.setFloat32(offset + 10, entity.y, true);
    view.setFloat32(offset + 14, entity.vx, true);
    view.setFloat32(offset + 18, entity.vy, true);
    view.setUint16(offset + 22, quantizeAngle(entity.angle), true);
    offset += COMMON_SIZE;

    switch (entity.kind) {
      case "ship":
        view.setUint8(offset, clampByte(entity.hp));
        view.setUint16(
          offset + 1,
          Math.min(65535, Math.max(0, entity.score)),
          true,
        );
        break;
      case "bullet":
        view.setUint32(offset, entity.ownerId, true);
        view.setUint32(offset + 4, entity.fireSeq, true);
        break;
      case "asteroid":
        view.setUint8(offset, Math.min(255, Math.round(entity.radius)));
        break;
      case "pickup":
        break;
      default:
        return assertNever(entity, "unknown entity kind");
    }
    offset += extraSize(kind);
  }
  return bytes;
}

export interface DecodedSnapshot extends Snapshot {
  readonly type: "snapshot";
}

export function decodeSnapshot(data: BinaryData): DecodedSnapshot {
  const bytes = toBytes(data);
  if (bytes.length < HEADER_SIZE)
    throw new CodecError("snapshot frame too short");
  const view = viewOf(bytes);
  if (view.getUint8(0) !== FRAME_TYPE.SNAPSHOT)
    throw new CodecError("not a snapshot frame");
  if (view.getUint8(1) !== BINARY_VERSION)
    throw new CodecError(`unsupported binary version ${view.getUint8(1)}`);
  const count = view.getUint16(2, true);
  if (count > MAX_ENTITIES) throw new CodecError("too many entities");
  const tick = asTick(view.getUint32(4, true));
  const ack = asSeq(view.getUint32(8, true));

  const entities: EntityView[] = [];
  let offset = HEADER_SIZE;
  for (let index = 0; index < count; index += 1) {
    if (offset + COMMON_SIZE > bytes.length)
      throw new CodecError("snapshot truncated");
    const kindCode = view.getUint8(offset + 4);
    if (kindCode < 1 || kindCode > 4)
      throw new CodecError(`unknown entity kind ${kindCode}`);
    const size = COMMON_SIZE + extraSize(kindCode);
    if (offset + size > bytes.length)
      throw new CodecError("snapshot truncated");

    const flags = view.getUint8(offset + 5);
    const base = {
      id: asEntityId(view.getUint32(offset, true)),
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      angle: dequantizeAngle(view.getUint16(offset + 22, true)),
    };
    if (![base.x, base.y, base.vx, base.vy].every(Number.isFinite)) {
      throw new CodecError("non-finite number in snapshot");
    }

    const extra = offset + COMMON_SIZE;
    switch (kindCode) {
      case 1:
        if ((flags & ~KNOWN_SHIP_FLAGS) !== 0)
          throw new CodecError("invalid ship flags");
        entities.push({
          ...base,
          kind: "ship",
          flags,
          hp: view.getUint8(extra),
          score: view.getUint16(extra + 1, true),
        });
        break;
      case 2:
        entities.push({
          ...base,
          kind: "bullet",
          ownerId: asEntityId(view.getUint32(extra, true)),
          fireSeq: asSeq(view.getUint32(extra + 4, true)),
        });
        break;
      case 3:
        if ((flags & ~1) !== 0) throw new CodecError("invalid asteroid flags");
        entities.push({
          ...base,
          kind: "asteroid",
          radius: view.getUint8(extra),
          homing: flags === 1 ? 1 : 0,
        });
        break;
      default:
        if ((flags & ~1) !== 0) throw new CodecError("invalid pickup flags");
        entities.push({
          ...base,
          kind: "pickup",
          pickupType: flags === 1 ? 1 : 0,
        });
    }
    offset += size;
  }
  if (offset !== bytes.length)
    throw new CodecError("trailing bytes after snapshot");
  return { type: "snapshot", tick, ack, entities };
}

export type { Seq };
