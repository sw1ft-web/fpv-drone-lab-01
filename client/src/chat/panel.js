/** Chat + roster panel. All text goes through textContent, never innerHTML. */
export function mountChat(root, { connection, playerId }) {
  const rosterEl = root.querySelector("#roster");
  const logEl = root.querySelector("#chatLog");
  const statusEl = root.querySelector("#chatStatus");
  const form = root.querySelector("#chatForm");
  const input = root.querySelector("#chatInput");

  const addLine = (text, className = "") => {
    const line = document.createElement("div");
    line.className = `chat-line ${className}`.trim();
    line.textContent = text;
    logEl.append(line);
    while (logEl.childElementCount > 80) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  };

  const renderRoster = (roster) => {
    rosterEl.replaceChildren(
      ...roster.map((player) => {
        const item = document.createElement("li");
        item.textContent =
          player.id === playerId ? `${player.name} (you)` : player.name;
        return item;
      }),
    );
  };

  const unsubscribe = [
    connection.on("roster", (message) => renderRoster(message.roster)),
    connection.on("welcome", (message) => {
      renderRoster(message.roster);
      statusEl.textContent = "Connected";
      statusEl.dataset.kind = "ok";
    }),
    connection.on("chat", (message) =>
      addLine(`${message.from}: ${message.text}`),
    ),
    connection.on("error", (message) =>
      addLine(`Server: ${message.message}`, "error"),
    ),
  ];

  const onClose = (event) => {
    const { code, willReconnect } = event.detail;
    statusEl.textContent = willReconnect
      ? "Connection lost — reconnecting…"
      : `Disconnected (code ${code})`;
    statusEl.dataset.kind = "error";
  };
  const onReconnecting = (event) => {
    statusEl.textContent = `Reconnecting (attempt ${event.detail.attempt}, ${event.detail.delayMs} ms)…`;
  };
  connection.addEventListener("close", onClose);
  connection.addEventListener("reconnecting", onReconnecting);

  const onSubmit = (event) => {
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
      connection.removeEventListener("close", onClose);
      connection.removeEventListener("reconnecting", onReconnecting);
      form.removeEventListener("submit", onSubmit);
      logEl.replaceChildren();
      rosterEl.replaceChildren();
      root.hidden = true;
    },
  };
}
