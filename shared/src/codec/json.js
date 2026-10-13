import { COMMAND_MASK } from "../sim/command.js";
import { MAX_INPUTS_PER_MESSAGE, PROTOCOL_VERSION } from "../protocol/index.js";
import { CodecError } from "./errors.js";

const ENTITY_KINDS = new Set(["ship", "bullet", "asteroid", "pickup"]);

function parse(data) {
  let value;
  try {
    value = JSON.parse(
      typeof data === "string" ? data : new TextDecoder().decode(data),
    );
  } catch {
    throw new CodecError("malformed JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodecError("message must be a JSON object");
  }
  if (value.v !== PROTOCOL_VERSION)
    throw new CodecError(`unsupported protocol version ${String(value.v)}`);
  return value;
}

const isUint = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function encodeInput({ inputs }) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "input", inputs });
}

export function decodeInput(data) {
  const message = parse(data);
  if (message.type !== "input") throw new CodecError("not an input message");
  const { inputs } = message;
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > MAX_INPUTS_PER_MESSAGE
  ) {
    throw new CodecError("input count out of range");
  }
  const clean = inputs.map((input) => {
    if (
      input === null ||
      typeof input !== "object" ||
      !isUint(input.seq) ||
      !Number.isInteger(input.bits)
    ) {
      throw new CodecError("invalid input entry");
    }
    if (input.bits < 0 || (input.bits & ~COMMAND_MASK) !== 0)
      throw new CodecError("input bits out of range");
    return { seq: input.seq, bits: input.bits };
  });
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].seq !== clean[i - 1].seq + 1)
      throw new CodecError("input sequence numbers must be contiguous");
  }
  return { type: "input", inputs: clean };
}

export function encodeSnapshot({ tick, ack, entities }) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "snapshot",
    tick,
    ack,
    entities,
  });
}

export function decodeSnapshot(data) {
  const message = parse(data);
  if (message.type !== "snapshot")
    throw new CodecError("not a snapshot message");
  if (
    !isUint(message.tick) ||
    !isUint(message.ack) ||
    !Array.isArray(message.entities)
  ) {
    throw new CodecError("invalid snapshot header");
  }
  for (const entity of message.entities) {
    if (
      entity === null ||
      typeof entity !== "object" ||
      !ENTITY_KINDS.has(entity.kind) ||
      !isUint(entity.id)
    ) {
      throw new CodecError("invalid entity");
    }
    for (const key of ["x", "y", "vx", "vy", "angle"]) {
      if (!Number.isFinite(entity[key]))
        throw new CodecError(`invalid entity field ${key}`);
    }
  }
  return {
    type: "snapshot",
    tick: message.tick,
    ack: message.ack,
    entities: message.entities,
  };
}
