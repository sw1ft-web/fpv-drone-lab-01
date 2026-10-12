/**
 * WebSocket wrapper for protocol v0.
 *
 * - `on(type, handler)` dispatches incoming server messages by `message.type`;
 * - messages sent while the socket is not open are queued and flushed in order;
 * - on an unexpected close it reconnects with exponential backoff + jitter and
 *   re-sends the session message (the `join`) before flushing the queue;
 * - fatal close codes (protocol violations, rate limit...) never reconnect.
 *
 * Lifecycle events (EventTarget): `open`, `close` {code, reason, willReconnect},
 * `reconnecting` {attempt, delayMs}.
 */
const FATAL_CLOSE_CODES = new Set([1009, 4000, 4001, 4002, 4003, 4004, 4005]);
const MAX_QUEUE = 100;

/** Exponential backoff with jitter: the delay is 50-100% of min(maxMs, baseMs * 2^attempt). */
export function backoffDelay(attempt, { baseMs, maxMs, random = Math.random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export class Connection extends EventTarget {
  #socket = null;
  #queue = [];
  #handlers = new Map();
  #session = null;
  #attempt = 0;
  #retryTimer = 0;
  #manuallyClosed = false;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 250,
    maxMs = 8000,
    random = Math.random,
  }) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.random = random;
    this.state = "idle"; // idle | connecting | open | reconnecting | closed
  }

  /** Message that is sent first after every (re)connect, e.g. the `join`. */
  setSession(message) {
    this.#session = message;
  }

  connect() {
    if (this.#socket || this.#manuallyClosed) return;
    this.state = this.#attempt === 0 ? "connecting" : "reconnecting";
    const socket = new this.WebSocketImpl(this.url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.state = "open";
      if (this.#session) this.#transmit(this.#session);
      for (const message of this.#queue.splice(0)) this.#transmit(message);
      this.dispatchEvent(new Event("open"));
    });

    socket.addEventListener("message", (event) => this.#onMessage(event.data));

    socket.addEventListener("close", (event) => {
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

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return; // the server only sends JSON; ignore anything else
    }
    const handlers = this.#handlers.get(message?.type);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(message);
  }

  /** Subscribes to one server message type; returns an unsubscribe function. */
  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.#handlers.get(type)?.delete(handler);
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
    this.#socket?.send(JSON.stringify({ v: 0, ...message }));
  }

  close(code = 1000, reason = "client closed") {
    this.#manuallyClosed = true;
    clearTimeout(this.#retryTimer);
    this.#queue.length = 0;
    this.state = "closed";
    this.#socket?.close(code, reason);
  }
}
