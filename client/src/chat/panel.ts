import { query } from "../dom.ts";
import type { WelcomeMessage } from "@fpv/shared/protocol";
import type { Connection } from "../net/connection.ts";

export interface ChatPanel {
  show(): void;
  focusInput(): void;
  destroy(): void;
}

/** Chat + roster panel. All text goes through textContent, never innerHTML. */
export function mountChat(
  root: HTMLElement,
  {
    connection,
    playerId,
    welcome,
  }: {
    connection: Connection;
    playerId: string;
    /** The welcome that already arrived: the panel is mounted after it, so it must be applied here. */
    welcome?: WelcomeMessage;
  },
): ChatPanel {
  const rosterEl = query(root, "#roster", HTMLElement);
  const logEl = query(root, "#chatLog", HTMLElement);
  const statusEl = query(root, "#chatStatus", HTMLElement);
  const form = query(root, "#chatForm", HTMLFormElement);
  const input = query(root, "#chatInput", HTMLInputElement);

  const setStatus = (text: string, kind?: "ok" | "error"): void => {
    statusEl.textContent = text;
    if (kind) statusEl.dataset["kind"] = kind;
  };

  const addLine = (text: string, className = ""): void => {
    const line = document.createElement("div");
    line.className = `chat-line ${className}`.trim();
    line.textContent = text;
    logEl.append(line);
    while (logEl.childElementCount > 80) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
  };

  const renderRoster = (
    roster: readonly { id: string; name: string }[],
  ): void => {
    rosterEl.replaceChildren(
      ...roster.map((player) => {
        const item = document.createElement("li");
        item.textContent =
          player.id === playerId ? `${player.name} (you)` : player.name;
        return item;
      }),
    );
  };

  if (welcome) {
    renderRoster(welcome.roster);
    setStatus("Connected", "ok");
  }

  const unsubscribe = [
    connection.on("roster", (message) => renderRoster(message.roster)),
    connection.on("welcome", (message) => {
      renderRoster(message.roster);
      setStatus("Connected", "ok");
    }),
    connection.on("chat", (message) =>
      addLine(`${message.from}: ${message.text}`),
    ),
    connection.on("shutdown", (message) =>
      addLine(`Server: ${message.message}`, "error"),
    ),
    connection.on("error", (message) =>
      addLine(`Server: ${message.message}`, "error"),
    ),
    connection.lifecycle.on("close", ({ code, willReconnect }) =>
      setStatus(
        willReconnect
          ? "Connection lost — reconnecting…"
          : `Disconnected (code ${code})`,
        "error",
      ),
    ),
    connection.lifecycle.on("reconnecting", ({ attempt, delayMs }) =>
      setStatus(`Reconnecting (attempt ${attempt}, ${delayMs} ms)…`),
    ),
  ];

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    connection.send({ type: "chat", text });
    input.value = "";
  };
  form.addEventListener("submit", onSubmit);

  return {
    show() {
      root.hidden = false;
    },
    focusInput() {
      input.focus();
    },
    destroy() {
      for (const off of unsubscribe) off();
      form.removeEventListener("submit", onSubmit);
      logEl.replaceChildren();
      rosterEl.replaceChildren();
      root.hidden = true;
    },
  };
}
