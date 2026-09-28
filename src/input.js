export function createInput(target) {
  const down = new Set();
  const pressed = new Set();

  const onKeyDown = (event) => {
    if (!event.repeat) pressed.add(event.code);
    down.add(event.code);

    if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(
        event.code,
      )
    ) {
      event.preventDefault();
    }
  };

  const onKeyUp = (event) => {
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