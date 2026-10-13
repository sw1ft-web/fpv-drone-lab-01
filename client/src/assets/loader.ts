import { assertNever } from "@fpv/shared";
import { ManifestSchema } from "./schema.ts";
import type { AssetJob, Manifest, SpriteAsset } from "./schema.ts";
import { fetchArrayBuffer, fetchBlob, fetchJson, withRetry } from "./http.ts";
import type { RetryInfo } from "./http.ts";

interface LoadOptions {
  signal?: AbortSignal | undefined;
  attempts?: number;
  baseMs?: number;
  onRetry?: ((info: RetryInfo) => void) | undefined;
}

function imageFromBlob(
  blob: Blob,
  signal: AbortSignal | undefined,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);

    const cleanup = (): void => {
      URL.revokeObjectURL(objectUrl);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      image.src = "";
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
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
  url: string,
  { signal, attempts = 3, baseMs = 180, onRetry }: LoadOptions = {},
): Promise<HTMLImageElement> {
  return withRetry(
    async () => imageFromBlob(await fetchBlob(url, { signal }), signal),
    { attempts, baseMs, signal, onRetry },
  );
}

export function loadAudio(
  audioContext: AudioContext,
  url: string,
  { signal, attempts = 3, baseMs = 180, onRetry }: LoadOptions = {},
): Promise<AudioBuffer> {
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
  url: string,
  { signal, attempts = 3, baseMs = 180, onRetry }: LoadOptions = {},
): Promise<unknown> {
  return withRetry(() => fetchJson(url, { signal }), {
    attempts,
    baseMs,
    signal,
    onRetry,
  });
}

/** Loads and validates /assets/manifest.json. */
export async function loadManifest(
  url: string,
  options: LoadOptions = {},
): Promise<Manifest> {
  return ManifestSchema.parse(await loadJson(url, options));
}

export interface Progress {
  completed: number;
  total: number;
  percent: number;
  item: AssetJob | null;
}

export interface LoadAllOptions {
  audioContext?: AudioContext | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (progress: Progress) => void;
  onRetry?: (info: RetryInfo & { item: AssetJob }) => void;
}

export interface LoadedImage extends SpriteAsset {
  image: HTMLImageElement;
}

export interface Assets {
  images: Map<string, LoadedImage>;
  audio: Map<string, AudioBuffer>;
  json: Map<string, unknown>;
  manifest: Manifest;
}

export async function loadAll(
  manifest: Manifest,
  { audioContext, signal, onProgress, onRetry }: LoadAllOptions = {},
): Promise<Assets> {
  const images = new Map<string, LoadedImage>();
  const audio = new Map<string, AudioBuffer>();
  const json = new Map<string, unknown>();

  const jobs: AssetJob[] = [
    ...manifest.sprites.map((item): AssetJob => ({ ...item, type: "image" })),
    ...manifest.audio.map((item): AssetJob => ({ ...item, type: "audio" })),
    ...manifest.json.map((item): AssetJob => ({ ...item, type: "json" })),
  ];

  let completed = 0;
  const total = jobs.length;
  onProgress?.({ completed, total, percent: 0, item: null });

  const tasks = jobs.map(async (item) => {
    const retry = (info: RetryInfo): void => onRetry?.({ item, ...info });

    switch (item.type) {
      case "image": {
        const image = await loadImage(item.url, { signal, onRetry: retry });
        images.set(item.id, { image, ...item });
        break;
      }
      case "audio": {
        if (!audioContext)
          throw new Error("AudioContext is required for audio assets");
        audio.set(
          item.id,
          await loadAudio(audioContext, item.url, { signal, onRetry: retry }),
        );
        break;
      }
      case "json":
        json.set(item.id, await loadJson(item.url, { signal, onRetry: retry }));
        break;
      default:
        return assertNever(item, "unknown asset type");
    }

    completed += 1;
    onProgress?.({
      completed,
      total,
      percent: total === 0 ? 1 : completed / total,
      item,
    });
  });

  await Promise.all(tasks);
  return { images, audio, json, manifest };
}

export interface BenchmarkResult {
  sequentialMs: number;
  concurrentMs: number;
}

export async function benchmarkLoadAll(
  manifest: Manifest,
  { audioContext }: { audioContext?: AudioContext | undefined } = {},
): Promise<BenchmarkResult> {
  const jobs: (() => Promise<unknown>)[] = [
    ...manifest.sprites.map(
      (item) => () => loadImage(cacheBust(item.url), { attempts: 1 }),
    ),
    ...(audioContext
      ? manifest.audio.map(
          (item) => () =>
            loadAudio(audioContext, cacheBust(item.url), { attempts: 1 }),
        )
      : []),
    ...manifest.json.map(
      (item) => () => loadJson(cacheBust(item.url), { attempts: 1 }),
    ),
  ];

  const sequentialStart = performance.now();
  for (const job of jobs) await job();
  const sequentialMs = performance.now() - sequentialStart;

  const concurrentStart = performance.now();
  await Promise.all(jobs.map((job) => job()));
  const concurrentMs = performance.now() - concurrentStart;

  return { sequentialMs, concurrentMs };
}

function cacheBust(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}bench=${performance.now()}-${Math.random()}`;
}
