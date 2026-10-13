export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
}

const BROWSER_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

export function createInput(target: Window): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();

  // Typing in the chat box must not steer the ship.
  const isTyping = (event: KeyboardEvent): boolean =>
    event.target instanceof HTMLElement &&
    (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTyping(event)) return;
    if (!event.repeat) pressed.add(event.code);
    down.add(event.code);
    if (BROWSER_KEYS.has(event.code)) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    down.delete(event.code);
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => {
      const result = pressed.has(code);
      pressed.delete(code);
      return result;
    },
  };
}
