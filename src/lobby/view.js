export function mountLobby(lobby, root) {
  const form = root.querySelector("#lobbyForm");
  const nameInput = root.querySelector("#playerName");
  const roomsEl = root.querySelector("#roomList");
  const statusEl = root.querySelector("#lobbyStatus");
  const refreshButton = root.querySelector("#refreshRooms");

  function renderRooms(rooms) {
    const previous = form.elements.room?.value;
    roomsEl.replaceChildren();

    for (const room of rooms) {
      const label = document.createElement("label");
      label.className = "room-card";
      const disabled = room.players >= room.maxPlayers;
      label.innerHTML = `
        <input type="radio" name="room" value="${escapeHtml(room.id)}" ${disabled ? "disabled" : ""}>
        <span class="room-main">
          <b>${escapeHtml(room.name)}</b>
          <small>Arena: ${escapeHtml(room.arenaId)}</small>
        </span>
        <span class="room-count">${room.players}/${room.maxPlayers}</span>
      `;
      roomsEl.append(label);
    }

    const restore = [...form.elements.room ?? []].find((input) => input.value === previous);
    if (restore && !restore.disabled) restore.checked = true;
    else roomsEl.querySelector('input[name="room"]:not(:disabled)')?.click();
  }

  lobby.addEventListener("roomsChanged", (event) => renderRooms(event.detail.rooms));
  lobby.addEventListener("status", (event) => {
    statusEl.textContent = event.detail;
    statusEl.dataset.kind = "ok";
  });
  lobby.addEventListener("error", (event) => {
    statusEl.textContent = `Room refresh failed: ${event.detail.message}`;
    statusEl.dataset.kind = "error";
  });

  refreshButton.addEventListener("click", () => {
    statusEl.textContent = "Refreshing…";
    lobby.refresh().catch((error) => {
      statusEl.textContent = `${error.name}: ${error.message}`;
      statusEl.dataset.kind = "error";
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomId = new FormData(form).get("room");
    try {
      lobby.join(String(roomId ?? ""), nameInput.value);
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.dataset.kind = "error";
    }
  });

  return {
    show() {
      root.hidden = false;
      nameInput.focus();
    },
    hide() {
      root.hidden = true;
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
