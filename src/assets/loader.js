import {
  fetchArrayBuffer,
  fetchBlob,
  fetchJson,
  withRetry,
} from "./http.js";

function imageFromBlob(blob, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      image.src = "";
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };

    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Image decode failed"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    image.src = objectUrl;
  });
}

export function loadImage(
  url,
  { signal, attempts = 3, baseMs = 180, onRetry } = {},
) {
  return withRetry(
    async () => imageFromBlob(await fetchBlob(url, { signal }), signal),
    { attempts, baseMs, signal, onRetry },
  );
}

export function loadAudio(
  audioContext,
  url,
  { signal, attempts = 3, baseMs = 180, onRetry } = {},
) {
  return withRetry(
    async () => {
      const bytes = await fetchArrayBuffer(url, { signal });
      signal?.throwIfAborted();
      return audioContext.decodeAudioData(bytes);
    },
    { attempts, baseMs, signal, onRetry },
  );
}

export function loadJson(
  url,
  { signal, attempts = 3, baseMs = 180, onRetry } = {},
) {
  return withRetry(() => fetchJson(url, { signal }), {
    attempts,
    baseMs,
    signal,
    onRetry,
  });
}

export async function loadAll(
  manifest,
  { audioContext, signal, onProgress = () => {}, onRetry = () => {} } = {},
) {
  const images = new Map();
  const audio = new Map();
  const json = new Map();

  const jobs = [
    ...(manifest.sprites ?? []).map((item) => ({ ...item, type: "image" })),
    ...(manifest.audio ?? []).map((item) => ({ ...item, type: "audio" })),
    ...(manifest.json ?? []).map((item) => ({ ...item, type: "json" })),
  ];

  let completed = 0;
  const total = jobs.length;
  onProgress({ completed, total, percent: 0, item: null });

  const tasks = jobs.map(async (item) => {
    let value;
    const retry = (info) => onRetry({ item, ...info });

    if (item.type === "image") {
      value = await loadImage(item.url, { signal, onRetry: retry });
      images.set(item.id, { image: value, ...item });
    } else if (item.type === "audio") {
      if (!audioContext) throw new Error("AudioContext is required for audio assets");
      value = await loadAudio(audioContext, item.url, { signal, onRetry: retry });
      audio.set(item.id, value);
    } else {
      value = await loadJson(item.url, { signal, onRetry: retry });
      json.set(item.id, value);
    }

    completed += 1;
    onProgress({
      completed,
      total,
      percent: total === 0 ? 1 : completed / total,
      item,
    });
    return value;
  });

  await Promise.all(tasks);
  return { images, audio, json, manifest };
}

export async function benchmarkLoadAll(manifest, { audioContext } = {}) {
  const jobs = [
    ...(manifest.sprites ?? []).map((item) => () => loadImage(cacheBust(item.url), { attempts: 1 })),
    ...(manifest.audio ?? []).map((item) => () => loadAudio(audioContext, cacheBust(item.url), { attempts: 1 })),
    ...(manifest.json ?? []).map((item) => () => loadJson(cacheBust(item.url), { attempts: 1 })),
  ];

  const sequentialStart = performance.now();
  for (const job of jobs) await job();
  const sequentialMs = performance.now() - sequentialStart;

  const concurrentStart = performance.now();
  await Promise.all(jobs.map((job) => job()));
  const concurrentMs = performance.now() - concurrentStart;

  return { sequentialMs, concurrentMs };
}

function cacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}bench=${performance.now()}-${Math.random()}`;
}
