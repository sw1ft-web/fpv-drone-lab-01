export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(
    response: Response,
    message = `HTTP ${response.status} ${response.statusText}`,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = response.status;
    this.url = response.url;
  }
}

interface RequestOptions {
  signal?: AbortSignal | undefined;
}

function throwIfNotOk(response: Response): Response {
  if (!response.ok) throw new HttpError(response);
  return response;
}

/** JSON from the network is `unknown`: callers validate it with a schema. */
export async function fetchJson(
  url: string,
  { signal }: RequestOptions = {},
): Promise<unknown> {
  const response = throwIfNotOk(await fetch(url, { signal: signal ?? null }));
  return response.json();
}

export async function postJson(
  url: string,
  body: unknown,
  { signal }: RequestOptions = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => ({}));
    const message =
      typeof detail === "object" &&
      detail !== null &&
      "error" in detail &&
      typeof detail.error === "string"
        ? detail.error
        : `HTTP ${response.status} ${response.statusText}`;
    throw new HttpError(response, message);
  }
  return response.json();
}

export async function fetchBlob(
  url: string,
  { signal }: RequestOptions = {},
): Promise<Blob> {
  const response = throwIfNotOk(await fetch(url, { signal: signal ?? null }));
  return response.blob();
}

export async function fetchArrayBuffer(
  url: string,
  { signal }: RequestOptions = {},
): Promise<ArrayBuffer> {
  const response = throwIfNotOk(await fetch(url, { signal: signal ?? null }));
  return response.arrayBuffer();
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

/** True for the errors an aborted fetch or timeout produces. */
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "TimeoutError");

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  signal?: AbortSignal | undefined;
  onRetry?: ((info: RetryInfo) => void) | undefined;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  { attempts = 3, baseMs = 180, signal, onRetry }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (isAbortError(error) || signal?.aborted) throw error;
      if (
        error instanceof HttpError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }
      if (attempt === attempts - 1) break;

      const exponential = baseMs * 2 ** attempt;
      const jitter = Math.random() * baseMs * 0.45;
      const delayMs = Math.round(exponential + jitter);
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

export function combineSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const [first] = active;
  if (!first) return undefined;
  if (active.length === 1) return first;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(abortReason(signal));
  };

  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}
