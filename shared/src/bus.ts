/**
 * Method-style parameter bivariance: lets one Set hold handlers for different
 * events without an `any` or a cast (a handler for `E[K]` is stored as a handler
 * for the union of all payloads; `emit` keeps the name and payload linked).
 */
type Handler<Payload> = {
  bivarianceHack(payload: Payload): void;
}["bivarianceHack"];

/**
 * A tiny typed event bus. `E` maps event names to payload types, so the name
 * and the payload can never disagree:
 *
 *   const bus = new Bus<{ hit: { damage: number } }>();
 *   bus.emit("hit", { damage: 10 });      // ok
 *   bus.emit("hit", { dmg: 10 });         // compile error
 *
 * `K extends keyof E` ties the event name to `E[K]`, the payload type.
 */
export class Bus<E extends { [name: string]: unknown }> {
  readonly #handlers = new Map<keyof E, Set<Handler<E[keyof E]>>>();

  /** Subscribes; returns the function that unsubscribes. */
  on<K extends keyof E>(name: K, handler: (payload: E[K]) => void): () => void {
    let set = this.#handlers.get(name);
    if (!set) {
      set = new Set();
      this.#handlers.set(name, set);
    }
    set.add(handler);
    return () => this.off(name, handler);
  }

  off<K extends keyof E>(name: K, handler: (payload: E[K]) => void): void {
    this.#handlers.get(name)?.delete(handler);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.#handlers.get(name);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }
}
