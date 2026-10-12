import { LatencyInjector } from "@fpv/shared";
import { FATAL_CLOSE_CODES, PROTOCOL_VERSION } from "@fpv/shared/protocol";

/**
 * WebSocket wrapper for protocol v1.
 *
 * - `on(type, handler)` dispatches incoming JSON server messages by `message.type`;
 * - `onBinary(handler)` receives binary frames (snapshots in the binary codec);
 * - `send()` takes a JSON message object or a ready-made Uint8Array frame;
 * - messages sent while the socket is not open are queued and flushed in order;
 * - on an unexpected close it reconnects with exponential backoff + jitter and
 *   re-sends the session message (the `join`) before flushing the queue;
 * - fatal close codes (protocol violations, rate limit...) never reconnect;
 * - `setNetwork({latencyMs, jitterMs, drop})` simulates a bad network in both
 *   directions (drop only affects game traffic: input and snapshot frames).
 *
 * Lifecycle events (EventTarget): `open`, `close` {code, reason, willReconnect},
 * `reconnecting` {attempt, delayMs}.
 */
const MAX_QUEUE = 100;
const GAME_TYPES = new Set(["input", "snapshot"]);

/** Exponential backoff with jitter: the delay is 50-100% of min(maxMs, baseMs * 2^attempt). */
export function backoffDelay(attempt, { baseMs, maxMs, random = Math.random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export class Connection extends EventTarget {
  #socket = null;
  #queue = [];
  #handlers = new Map();
  #binaryHandlers = new Set();
  #session = null;
  #attempt = 0;
  #retryTimer = 0;
  #manuallyClosed = false;
  #upstream;
  #downstream;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 250,
    maxMs = 8000,
    random = Math.random,
    network = {},
  }) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.random = random;
    this.state = "idle"; // idle | connecting | open | reconnecting | closed
    this.bytesIn = 0;
    this.bytesOut = 0;
    // One injector per direction keeps each direction in order, like a real socket.
    this.#upstream = new LatencyInjector({ ...network });
    this.#downstream = new LatencyInjector({ ...network });
  }

  /** Changes the simulated network on the fly (no reconnect needed). */
  setNetwork({ latencyMs = 0, jitterMs = 0, drop = 0 } = {}) {
    for (const injector of [this.#upstream, this.#downstream]) {
      injector.latencyMs = latencyMs;
      injector.jitterMs = jitterMs;
      injector.drop = drop;
    }
  }

  get network() {
    const { latencyMs, jitterMs, drop } = this.#upstream;
    return { latencyMs, jitterMs, drop };
  }

  /** Message that is sent first after every (re)connect, e.g. the `join`. */
  setSession(message) {
    this.#session = message;
  }

  connect() {
    if (this.#socket || this.#manuallyClosed) return;
    this.state = this.#attempt === 0 ? "connecting" : "reconnecting";
    const socket = new this.WebSocketImpl(this.url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.state = "open";
      if (this.#session) this.#transmit(this.#session);
      for (const message of this.#queue.splice(0)) this.#transmit(message);
      this.dispatchEvent(new Event("open"));
    });

    socket.addEventListener("message", (event) =>
      this.#receive(event.data, socket),
    );

    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      const willReconnect =
        !this.#manuallyClosed && !FATAL_CLOSE_CODES.has(event.code);
      this.state = willReconnect ? "reconnecting" : "closed";
      this.dispatchEvent(
        new CustomEvent("close", {
          detail: { code: event.code, reason: event.reason, willReconnect },
        }),
      );
      if (willReconnect) this.#scheduleReconnect();
    });

    // 'error' is always followed by 'close'; nothing extra to do, but listen so it is never unhandled.
    socket.addEventListener("error", () => {});
  }

  #scheduleReconnect() {
    const delayMs = backoffDelay(this.#attempt, {
      baseMs: this.baseMs,
      maxMs: this.maxMs,
      random: this.random,
    });
    this.#attempt += 1;
    this.dispatchEvent(
      new CustomEvent("reconnecting", {
        detail: { attempt: this.#attempt, delayMs },
      }),
    );
    this.#retryTimer = setTimeout(() => this.connect(), delayMs);
  }

  #receive(data, socket) {
    const isBinary = typeof data !== "string";
    const size = isBinary ? data.byteLength : data.length;
    this.bytesIn += size;
    // Control messages are never dropped; only snapshots may be lost.
    let reliable = true;
    let message = null;
    if (!isBinary) {
      try {
        message = JSON.parse(data);
      } catch {
        return; // the server only sends JSON text or binary frames
      }
      reliable = !GAME_TYPES.has(message?.type);
    } else {
      reliable = false;
    }
    this.#downstream.send(
      null,
      () => {
        if (this.#socket !== socket) return;
        if (isBinary) {
          const bytes = new Uint8Array(data);
          for (const handler of [...this.#binaryHandlers]) handler(bytes, size);
        } else {
          const handlers = this.#handlers.get(message?.type);
          if (!handlers) return;
          for (const handler of [...handlers]) handler(message, size);
        }
      },
      { reliable },
    );
  }

  /** Subscribes to one server message type; returns an unsubscribe function. */
  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.#handlers.get(type)?.delete(handler);
  }

  /** Subscribes to binary frames; returns an unsubscribe function. */
  onBinary(handler) {
    this.#binaryHandlers.add(handler);
    return () => this.#binaryHandlers.delete(handler);
  }

  send(message) {
    if (this.state === "open") {
      this.#transmit(message);
      return true;
    }
    if (this.#manuallyClosed || this.state === "closed") return false;
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift();
    this.#queue.push(message);
    return true;
  }

  #transmit(message) {
    const socket = this.#socket;
    if (!socket) return;
    const binary = message instanceof Uint8Array;
    const payload = binary
      ? message
      : JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    this.bytesOut += binary ? payload.byteLength : payload.length;
    const reliable = binary ? false : !GAME_TYPES.has(message.type);
    this.#upstream.send(
      payload,
      (data) => {
        if (this.#socket === socket && socket.readyState === 1)
          socket.send(data);
      },
      { reliable },
    );
  }

  close(code = 1000, reason = "client closed") {
    this.#manuallyClosed = true;
    clearTimeout(this.#retryTimer);
    this.#queue.length = 0;
    this.state = "closed";
    this.#socket?.close(code, reason);
  }
}
