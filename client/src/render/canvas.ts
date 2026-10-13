export interface CanvasHandle {
  readonly context: CanvasRenderingContext2D;
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export function setupCanvas(canvas: HTMLCanvasElement): CanvasHandle {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is not available");
  let cssWidth = 0;
  let cssHeight = 0;

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  window.addEventListener("resize", resize);
  resize();

  return {
    context,
    get cssWidth() {
      return cssWidth;
    },
    get cssHeight() {
      return cssHeight;
    },
  };
}
