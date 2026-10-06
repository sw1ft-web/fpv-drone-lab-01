export class AudioManager {
  #context = null;
  #buffers = new Map();
  #subscriptions = [];

  get context() {
    return this.#context;
  }

  async unlock() {
    if (!this.#context) {
      const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio API is not supported");
      this.#context = new AudioContextClass();
    }
    if (this.#context.state === "suspended") await this.#context.resume();
    return this.#context;
  }

  setBuffers(buffers) {
    this.#buffers = buffers;
  }

  attach(eventTarget) {
    this.detach();
    for (const eventName of ["fired", "hit", "exploded"]) {
      const handler = () => this.play(eventName);
      eventTarget.addEventListener(eventName, handler);
      this.#subscriptions.push([eventTarget, eventName, handler]);
    }
  }

  detach() {
    for (const [target, eventName, handler] of this.#subscriptions) {
      target.removeEventListener(eventName, handler);
    }
    this.#subscriptions = [];
  }

  play(id, gainValue = 0.32) {
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
