import { Bus, LatencyInjector } from "@fpv/shared";
import type { LatencyOptions, NetworkConditions } from "@fpv/shared";
import {
  FATAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  parseServerMessage,
} from "@fpv/shared/protocol";
import type {
  ClientMessageInput,
  ServerMessage,
  ServerMessageType,
} from "@fpv/shared/protocol";

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
 * Lifecycle events are on the typed `lifecycle` bus (see ConnectionEvents):
 * `open`, `close` {code, reason, willReconnect}, `reconnecting` {attempt, delayMs}.
 * Every incoming JSON message is validated with the shared zod schema before any
 * handler sees it; a message that does not match is counted in `invalidMessages`.
 */
const MAX_QUEUE = 100;
const GAME_TYPES: ReadonlySet<string> = new Set(["input", "snapshot"]);

/** What `send` accepts: a message object (JSON codec) or a ready-made binary frame. */
export type Outbound = ClientMessageInput | Uint8Array<ArrayBuffer>;
type BinaryHandler = (bytes: Uint8Array, size: number) => void;

export type ConnectionState =
  "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type ConnectionEvents = {
  open: undefined;
  close: {
    readonly code: number;
    readonly reason: string;
    readonly willReconnect: boolean;
  };
  reconnecting: { readonly attempt: number; readonly delayMs: number };
};

/** What a typed `on("welcome", ...)` handler receives: the message, with its wire size in bytes. */
type MessageEvents = {
  [M in ServerMessage as M["type"]]: M & { readonly size: number };
};

/**
 * The part of the WebSocket API the connection uses. The browser's WebSocket and
 * the `ws` package's both satisfy it, which is what lets tests inject their own.
 */
export interface SocketEvent {
  readonly type?: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketEvent) => void,
  ): void;
}
export type SocketConstructor = new (url: string) => SocketLike;

export interface ConnectionOptions {
  url: string;
  WebSocketImpl?: SocketConstructor;
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  network?: LatencyOptions;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

/** Exponential backoff with jitter: the delay is 50-100% of min(maxMs, baseMs * 2^attempt). */
export function backoffDelay(
  attempt: number,
  { baseMs, maxMs, random = Math.random }: BackoffOptions,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export class Connection {
  readonly lifecycle = new Bus<ConnectionEvents>();
  readonly url: string;
  readonly WebSocketImpl: SocketConstructor;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random: () => number;
  state: ConnectionState = "idle";
  bytesIn = 0;
  bytesOut = 0;
  invalidMessages = 0;

  #socket: SocketLike | null = null;
  readonly #queue: Outbound[] = [];
  readonly #messages = new Bus<MessageEvents>();
  readonly #binaryHandlers = new Set<BinaryHandler>();
  #session: ClientMessageInput | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #manuallyClosed = false;
  readonly #upstream: LatencyInjector;
  readonly #downstream: LatencyInjector;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 250,
    maxMs = 8000,
    random = Math.random,
    network = {},
  }: ConnectionOptions) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.random = random;
    // One injector per direction keeps each direction in order, like a real socket.
    this.#upstream = new LatencyInjector({ ...network });
    this.#downstream = new LatencyInjector({ ...network });
  }

  /** Changes the simulated network on the fly (no reconnect needed). */
  setNetwork({
    latencyMs = 0,
    jitterMs = 0,
    drop = 0,
  }: Partial<NetworkConditions> = {}): void {
    for (const injector of [this.#upstream, this.#downstream]) {
      injector.latencyMs = latencyMs;
      injector.jitterMs = jitterMs;
      injector.drop = drop;
    }
  }

  get network(): NetworkConditions {
    const { latencyMs, jitterMs, drop } = this.#upstream;
    return { latencyMs, jitterMs, drop };
  }

  /** Message that is sent first after every (re)connect, e.g. the `join`. */
  setSession(message: ClientMessageInput): void {
    this.#session = message;
  }

  connect(): void {
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
      this.lifecycle.emit("open", undefined);
    });

    socket.addEventListener("message", (event) => {
      this.#receive(event.data, socket);
    });

    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      const code = event.code ?? 1006; // 1006: closed without a close frame
      const willReconnect =
        !this.#manuallyClosed && !FATAL_CLOSE_CODES.has(code);
      this.state = willReconnect ? "reconnecting" : "closed";
      this.lifecycle.emit("close", {
        code,
        reason: event.reason ?? "",
        willReconnect,
      });
      if (willReconnect) this.#scheduleReconnect();
    });

    // 'error' is always followed by 'close'; nothing extra to do, but listen so it is never unhandled.
    socket.addEventListener("error", () => {});
  }

  #scheduleReconnect(): void {
    const delayMs = backoffDelay(this.#attempt, {
      baseMs: this.baseMs,
      maxMs: this.maxMs,
      random: this.random,
    });
    this.#attempt += 1;
    this.lifecycle.emit("reconnecting", { attempt: this.#attempt, delayMs });
    this.#retryTimer = setTimeout(() => this.connect(), delayMs);
  }

  #receive(data: unknown, socket: SocketLike): void {
    if (typeof data === "string") {
      this.#receiveText(data, socket);
    } else if (data instanceof ArrayBuffer) {
      this.#receiveBinary(data, socket);
    }
    // anything else cannot come from this protocol: ignore it
  }

  #receiveText(text: string, socket: SocketLike): void {
    const size = text.length;
    this.bytesIn += size;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.invalidMessages += 1;
      return; // the server only sends JSON text or binary frames
    }
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.invalidMessages += 1;
      return;
    }
    const message = parsed.value;
    // Control messages are never dropped; only snapshots may be lost.
    this.#downstream.send(
      null,
      () => {
        if (this.#socket !== socket) return;
        this.#messages.emit(message.type, { ...message, size });
      },
      { reliable: !GAME_TYPES.has(message.type) },
    );
  }

  #receiveBinary(data: ArrayBuffer, socket: SocketLike): void {
    const size = data.byteLength;
    this.bytesIn += size;
    this.#downstream.send(
      null,
      () => {
        if (this.#socket !== socket) return;
        const bytes = new Uint8Array(data);
        for (const handler of [...this.#binaryHandlers]) handler(bytes, size);
      },
      { reliable: false },
    );
  }

  /** Subscribes to one server message type; returns an unsubscribe function. */
  on<T extends ServerMessageType>(
    type: T,
    handler: (message: MessageEvents[T], size: number) => void,
  ): () => void {
    return this.#messages.on(type, (message) => handler(message, message.size));
  }

  /** Subscribes to binary frames; returns an unsubscribe function. */
  onBinary(handler: BinaryHandler): () => boolean {
    this.#binaryHandlers.add(handler);
    return () => this.#binaryHandlers.delete(handler);
  }

  send(message: Outbound): boolean {
    if (this.state === "open") {
      this.#transmit(message);
      return true;
    }
    if (this.#manuallyClosed || this.state === "closed") return false;
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift();
    this.#queue.push(message);
    return true;
  }

  #transmit(message: Outbound): void {
    const socket = this.#socket;
    if (!socket) return;
    const payload =
      message instanceof Uint8Array
        ? message
        : JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    this.bytesOut +=
      typeof payload === "string" ? payload.length : payload.byteLength;
    const reliable =
      message instanceof Uint8Array ? false : !GAME_TYPES.has(message.type);
    this.#upstream.send(
      payload,
      (data) => {
        if (this.#socket === socket && socket.readyState === 1)
          socket.send(data);
      },
      { reliable },
    );
  }

  close(code = 1000, reason = "client closed"): void {
    this.#manuallyClosed = true;
    clearTimeout(this.#retryTimer);
    this.#queue.length = 0;
    this.state = "closed";
    this.#socket?.close(code, reason);
  }
}
