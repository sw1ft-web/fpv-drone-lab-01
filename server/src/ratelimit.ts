/**
 * Token bucket: `capacity` tokens, refilled continuously at `refillPerSec`.
 * `take()` returns false when the caller is over its budget.
 */
export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}

export class TokenBucket {
  #tokens: number;
  #last: number;
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly now: () => number;

  constructor({
    capacity,
    refillPerSec,
    now = () => performance.now(),
  }: TokenBucketOptions) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  take(cost = 1): boolean {
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

  get tokens(): number {
    return this.#tokens;
  }
}
