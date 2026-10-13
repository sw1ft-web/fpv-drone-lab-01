/**
 * Token bucket: `capacity` tokens, refilled continuously at `refillPerSec`.
 * `take()` returns false when the caller is over its budget.
 */
export class TokenBucket {
  #tokens;
  #last;

  constructor({ capacity, refillPerSec, now = () => performance.now() }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  take(cost = 1) {
    const current = this.now();
    const elapsedSec = Math.max(0, current - this.#last) / 1000;
    this.#last = current;
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + elapsedSec * this.refillPerSec,
    );
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens() {
    return this.#tokens;
  }
}
