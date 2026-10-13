import * as binary from "./binary.js";
import * as json from "./json.js";

export { CodecError } from "./errors.js";
export {
  BINARY_VERSION,
  FRAME_TYPE,
  MAX_ENTITIES,
  dequantizeAngle,
  peekFrameType,
  quantizeAngle,
  snapshotByteLength,
} from "./binary.js";

/** Same interface, two wire formats. `binary: true` means messages are Uint8Array frames. */
export const jsonCodec = Object.freeze({
  name: "json",
  binary: false,
  encodeInput: json.encodeInput,
  decodeInput: json.decodeInput,
  encodeSnapshot: json.encodeSnapshot,
  decodeSnapshot: json.decodeSnapshot,
});

export const binaryCodec = Object.freeze({
  name: "binary",
  binary: true,
  encodeInput: binary.encodeInput,
  decodeInput: binary.decodeInput,
  encodeSnapshot: binary.encodeSnapshot,
  decodeSnapshot: binary.decodeSnapshot,
});

export function getCodec(name) {
  if (name === "binary") return binaryCodec;
  if (name === "json") return jsonCodec;
  throw new Error(`unknown codec "${name}"`);
}
