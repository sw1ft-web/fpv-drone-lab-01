import { SNAPSHOT_FLAGS, TAU } from "../constants.js";
import { COMMAND_MASK } from "../sim/command.js";
import { MAX_INPUTS_PER_MESSAGE } from "../protocol/index.js";
import { CodecError } from "./errors.js";

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

const KIND_CODE = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 };
const KIND_NAME = [null, "ship", "bullet", "asteroid", "pickup"];
const COMMON_SIZE = 24;
const EXTRA_SIZE = [0, 3, 8, 1, 0];
const HEADER_SIZE = 12;
const INPUT_HEADER_SIZE = 8;
const U32_MAX = 0xffffffff;

const toBytes = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError("expected binary data");
};

const viewOf = (bytes) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function quantizeAngle(angle) {
  return Math.round(((((angle % TAU) + TAU) % TAU) / TAU) * 65536) & 0xffff;
}
export const dequantizeAngle = (value) => (value / 65536) * TAU;

/** First byte of a binary frame, or -1 for an empty buffer. */
export function peekFrameType(data) {
  const bytes = toBytes(data);
  return bytes.length > 0 ? bytes[0] : -1;
}

export function encodeInput({ inputs }) {
  const count = inputs.length;
  if (count < 1 || count > MAX_INPUTS_PER_MESSAGE)
    throw new CodecError(`input count ${count} out of range`);
  const firstSeq = inputs[0].seq;
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

export function decodeInput(data) {
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

  const inputs = [];
  for (let index = 0; index < count; index += 1) {
    const bits = view.getUint8(INPUT_HEADER_SIZE + index);
    if ((bits & ~COMMAND_MASK) !== 0)
      throw new CodecError("input bits out of range");
    inputs.push({ seq: firstSeq + index, bits });
  }
  return { type: "input", inputs };
}

export function snapshotByteLength(entities) {
  let size = HEADER_SIZE;
  for (const entity of entities)
    size += COMMON_SIZE + EXTRA_SIZE[KIND_CODE[entity.kind]];
  return size;
}

export function encodeSnapshot({ tick, ack, entities }) {
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
    if (kind === undefined)
      throw new CodecError(`unknown entity kind ${entity.kind}`);
    let flags = 0;
    if (kind === 1) flags = entity.flags;
    else if (kind === 3) flags = entity.homing ? 1 : 0;
    else if (kind === 4) flags = entity.pickupType & 1;

    view.setUint32(offset, entity.id, true);
    view.setUint8(offset + 4, kind);
    view.setUint8(offset + 5, flags);
    view.setFloat32(offset + 6, entity.x, true);
    view.setFloat32(offset + 10, entity.y, true);
    view.setFloat32(offset + 14, entity.vx, true);
    view.setFloat32(offset + 18, entity.vy, true);
    view.setUint16(offset + 22, quantizeAngle(entity.angle), true);
    offset += COMMON_SIZE;

    if (kind === 1) {
      view.setUint8(offset, Math.min(255, Math.max(0, Math.round(entity.hp))));
      view.setUint16(
        offset + 1,
        Math.min(65535, Math.max(0, entity.score)),
        true,
      );
    } else if (kind === 2) {
      view.setUint32(offset, entity.ownerId, true);
      view.setUint32(offset + 4, entity.fireSeq, true);
    } else if (kind === 3) {
      view.setUint8(offset, Math.min(255, Math.round(entity.radius)));
    }
    offset += EXTRA_SIZE[kind];
  }
  return bytes;
}

export function decodeSnapshot(data) {
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
  const tick = view.getUint32(4, true);
  const ack = view.getUint32(8, true);

  const entities = [];
  let offset = HEADER_SIZE;
  for (let index = 0; index < count; index += 1) {
    if (offset + COMMON_SIZE > bytes.length)
      throw new CodecError("snapshot truncated");
    const kindCode = view.getUint8(offset + 4);
    const kind = KIND_NAME[kindCode];
    if (!kind) throw new CodecError(`unknown entity kind ${kindCode}`);
    const size = COMMON_SIZE + EXTRA_SIZE[kindCode];
    if (offset + size > bytes.length)
      throw new CodecError("snapshot truncated");

    const flags = view.getUint8(offset + 5);
    const entity = {
      id: view.getUint32(offset, true),
      kind,
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      angle: dequantizeAngle(view.getUint16(offset + 22, true)),
    };
    if (![entity.x, entity.y, entity.vx, entity.vy].every(Number.isFinite)) {
      throw new CodecError("non-finite number in snapshot");
    }

    const extra = offset + COMMON_SIZE;
    if (kindCode === 1) {
      if (
        (flags &
          ~(
            SNAPSHOT_FLAGS.ACTIVE |
            SNAPSHOT_FLAGS.INVULNERABLE |
            SNAPSHOT_FLAGS.SHIELD |
            SNAPSHOT_FLAGS.RAPID_FIRE |
            SNAPSHOT_FLAGS.THRUST
          )) !==
        0
      ) {
        throw new CodecError("invalid ship flags");
      }
      entity.flags = flags;
      entity.hp = view.getUint8(extra);
      entity.score = view.getUint16(extra + 1, true);
    } else if (kindCode === 2) {
      entity.ownerId = view.getUint32(extra, true);
      entity.fireSeq = view.getUint32(extra + 4, true);
    } else if (kindCode === 3) {
      if ((flags & ~1) !== 0) throw new CodecError("invalid asteroid flags");
      entity.radius = view.getUint8(extra);
      entity.homing = flags & 1;
    } else if (kindCode === 4) {
      if ((flags & ~1) !== 0) throw new CodecError("invalid pickup flags");
      entity.pickupType = flags & 1;
    }
    entities.push(entity);
    offset += size;
  }
  if (offset !== bytes.length)
    throw new CodecError("trailing bytes after snapshot");
  return { type: "snapshot", tick, ack, entities };
}
