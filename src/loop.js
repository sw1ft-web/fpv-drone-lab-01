const MAX_FRAME_DELTA = 0.25;

export function createLoop({ step = 1 / 60, simulate, render, onStats = () => {} }) {
  let animationId = 0;
  let running = false;
  let accumulator = 0;
  let last = performance.now();

  let stats = {
    stepsPerSecond: 0,
    framesPerSecond: 0,
    frameTimeMs: 0,
  };

  let stepCount = 0;
  let frameCount = 0;
  let statsTime = performance.now();

  function frame(now) {
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

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    accumulator = 0;
    animationId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(animationId);
  }

  return {
    start,
    stop,
    getStats: () => ({ ...stats }),
  };
}