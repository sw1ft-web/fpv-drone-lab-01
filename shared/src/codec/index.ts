import type { CodecName } from "../protocol/messages.ts";
import type { InputEntry, Snapshot } from "../types.ts";
import * as binary from "./binary.ts";
import type { BinaryData } from "./binary.ts";
import * as json from "./json.ts";
import type { JsonData } from "./json.ts";

export { CodecError } from "./errors.ts";
export {
  BINARY_VERSION,
  FRAME_TYPE,
  MAX_ENTITIES,
  dequantizeAngle,
  peekFrameType,
  quantizeAngle,
  snapshotByteLength,
} from "./binary.ts";
export type { BinaryData } from "./binary.ts";
export type { JsonData } from "./json.ts";

/**
 * One interface, two wire formats. `Frame` is what goes on the socket: a string
 * (JSON text) or bytes (binary frame). The generic parameter links the encoders
 * and the decoders of one codec, so a JSON codec cannot be fed binary frames by
 * accident.
 */
export interface Codec<Frame extends string | Uint8Array, Data> {
  readonly name: CodecName;
  readonly binary: boolean;
  readonly encodeInput: (message: {
    readonly inputs: readonly InputEntry[];
  }) => Frame;
  readonly decodeInput: (data: Data) => {
    readonly type: "input";
    readonly inputs: InputEntry[];
  };
  readonly encodeSnapshot: (snapshot: Snapshot) => Frame;
  readonly decodeSnapshot: (
    data: Data,
  ) => Snapshot & { readonly type: "snapshot" };
}

export type JsonCodec = Codec<string, JsonData> & { readonly name: "json" };
export type BinaryCodec = Codec<Uint8Array<ArrayBuffer>, BinaryData> & {
  readonly name: "binary";
};

export const jsonCodec: JsonCodec = Object.freeze({
  name: "json",
  binary: false,
  encodeInput: json.encodeInput,
  decodeInput: json.decodeInput,
  encodeSnapshot: json.encodeSnapshot,
  decodeSnapshot: json.decodeSnapshot,
});

export const binaryCodec: BinaryCodec = Object.freeze({
  name: "binary",
  binary: true,
  encodeInput: binary.encodeInput,
  decodeInput: binary.decodeInput,
  encodeSnapshot: binary.encodeSnapshot,
  decodeSnapshot: binary.decodeSnapshot,
});

export function getCodec(name: CodecName): JsonCodec | BinaryCodec {
  switch (name) {
    case "binary":
      return binaryCodec;
    case "json":
      return jsonCodec;
    default:
      return neverCodec(name);
  }
}

function neverCodec(name: never): never {
  throw new Error(`unknown codec "${String(name)}"`);
}
