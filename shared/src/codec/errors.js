/** Thrown by decoders for any malformed, truncated or out-of-range input. */
export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}
