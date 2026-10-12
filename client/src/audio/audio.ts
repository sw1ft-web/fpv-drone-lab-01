import type { GameClient } from "../net/gameclient.ts";

/** Sounds the game can play: the names are the keys of the audio manifest. */
export type SoundId = "fired" | "hit" | "exploded";
const SOUND_IDS: readonly SoundId[] = ["fired", "hit", "exploded"];

export class AudioManager {
  #context: AudioContext | null = null;
  #buffers: ReadonlyMap<string, AudioBuffer> = new Map();
  #subscriptions: (() => void)[] = [];

  get context(): AudioContext | null {
    return this.#context;
  }

  async unlock(): Promise<AudioContext> {
    if (!this.#context) {
      // Unprefixed since Safari 14.1; the old `webkitAudioContext` fallback is gone.
      if (typeof window.AudioContext !== "function")
        throw new Error("Web Audio API is not supported");
      this.#context = new window.AudioContext();
    }
    if (this.#context.state === "suspended") await this.#context.resume();
    return this.#context;
  }

  setBuffers(buffers: ReadonlyMap<string, AudioBuffer>): void {
    this.#buffers = buffers;
  }

  attach(game: GameClient): void {
    this.detach();
    this.#subscriptions = SOUND_IDS.map((id) =>
      game.events.on(id, () => this.play(id)),
    );
  }

  detach(): void {
    for (const off of this.#subscriptions) off();
    this.#subscriptions = [];
  }

  play(id: SoundId, gainValue = 0.32): void {
    if (!this.#context || this.#context.state !== "running") return;
    const buffer = this.#buffers.get(id);
    if (!buffer) return;

    const source = this.#context.createBufferSource();
    const gain = this.#context.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.#context.destination);
    source.start();
  }
}
