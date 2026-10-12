const MAX_FRAME_DELTA = 0.25;

export interface LoopStats {
  stepsPerSecond: number;
  framesPerSecond: number;
  frameTimeMs: number;
}

export interface LoopOptions {
  step?: number;
  simulate: (dt: number) => void;
  render: (alpha: number, stats: LoopStats) => void;
  onStats?: (stats: LoopStats) => void;
}

export interface Loop {
  start(): void;
  stop(): void;
  getStats(): LoopStats;
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  onStats = () => {},
}: LoopOptions): Loop {
  let animationId = 0;
  let running = false;
  let accumulator = 0;
  let last = performance.now();

  let stats: LoopStats = {
    stepsPerSecond: 0,
    framesPerSecond: 0,
    frameTimeMs: 0,
  };

  let stepCount = 0;
  let frameCount = 0;
  let statsTime = performance.now();

  function frame(now: number): void {
    if (!running) return;

    const frameStart = performance.now();
    const frameDelta = Math.min((now - last) / 1000, MAX_FRAME_DELTA);
    last = now;
    accumulator += frameDelta;

    while (accumulator >= step) {
      simulate(step);
      accumulator -= step;
      stepCount += 1;
    }

    const alpha = accumulator / step;

    render(alpha, stats);

    frameCount += 1;
    const elapsed = now - statsTime;

    if (elapsed >= 1000) {
      stats = {
        stepsPerSecond: (stepCount * 1000) / elapsed,
        framesPerSecond: (frameCount * 1000) / elapsed,
        frameTimeMs: performance.now() - frameStart,
      };

      stepCount = 0;
      frameCount = 0;
      statsTime = now;
      onStats(stats);
    } else {
      stats = {
        ...stats,
        frameTimeMs: performance.now() - frameStart,
      };
    }

    animationId = requestAnimationFrame(frame);
  }

  function start(): void {
    if (running) return;
    running = true;
    last = performance.now();
    accumulator = 0;
    animationId = requestAnimationFrame(frame);
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(animationId);
  }

  return {
    start,
    stop,
    getStats: () => ({ ...stats }),
  };
}
