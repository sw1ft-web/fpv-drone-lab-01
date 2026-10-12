/**
 * Network condition simulator: adds latency, jitter and packet loss to anything
 * that is delivered through `send(payload, deliver)`.
 *
 * Delivery order is preserved (like TCP / a WebSocket): a delayed message holds
 * back later ones. `drop` simulates an unreliable transport by discarding
 * messages, which is what exercises prediction and interpolation.
 *
 * `schedule(fn, ms)` and `now()` are injectable so tests and the headless
 * netcode harness can run on a virtual clock.
 */
export class LatencyInjector {
  #lastDeliveryAt = 0;

  constructor({
    latencyMs = 0,
    jitterMs = 0,
    drop = 0,
    random = Math.random,
    schedule = (fn, ms) => setTimeout(fn, ms),
    now = () => performance.now(),
  } = {}) {
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.drop = drop;
    this.random = random;
    this.schedule = schedule;
    this.now = now;
    this.sent = 0;
    this.dropped = 0;
  }

  get active() {
    return this.latencyMs > 0 || this.jitterMs > 0 || this.drop > 0;
  }

  /** `reliable` messages still get delay but are never dropped (control traffic on a real WebSocket). */
  send(payload, deliver, { reliable = false } = {}) {
    this.sent += 1;
    if (!this.active) {
      deliver(payload);
      return;
    }
    if (!reliable && this.drop > 0 && this.random() < this.drop) {
      this.dropped += 1;
      return;
    }
    const jitter =
      this.jitterMs > 0 ? (this.random() * 2 - 1) * this.jitterMs : 0;
    const arrival = Math.max(
      this.#lastDeliveryAt,
      this.now() + Math.max(0, this.latencyMs + jitter),
    );
    this.#lastDeliveryAt = arrival;
    this.schedule(() => deliver(payload), Math.max(0, arrival - this.now()));
  }
}
