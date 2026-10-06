export class HttpError extends Error {
  constructor(response, message = `HTTP ${response.status} ${response.statusText}`) {
    super(message);
    this.name = "HttpError";
    this.status = response.status;
    this.url = response.url;
  }
}

function throwIfNotOk(response) {
  if (!response.ok) throw new HttpError(response);
  return response;
}

export async function fetchJson(url, { signal } = {}) {
  const response = throwIfNotOk(await fetch(url, { signal }));
  return response.json();
}

export async function fetchBlob(url, { signal } = {}) {
  const response = throwIfNotOk(await fetch(url, { signal }));
  return response.blob();
}

export async function fetchArrayBuffer(url, { signal } = {}) {
  const response = throwIfNotOk(await fetch(url, { signal }));
  return response.arrayBuffer();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function withRetry(
  operation,
  { attempts = 3, baseMs = 180, signal, onRetry = () => {} } = {},
) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (error?.name === "AbortError" || signal?.aborted) throw error;
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        throw error;
      }
      if (attempt === attempts - 1) break;

      const exponential = baseMs * 2 ** attempt;
      const jitter = Math.random() * baseMs * 0.45;
      const delayMs = Math.round(exponential + jitter);
      onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

export function combineSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
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
