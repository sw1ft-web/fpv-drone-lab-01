import { errorMessage, query } from "../dom.ts";
import type { Lobby } from "./lobby.ts";

export type StatusKind = "ok" | "error";

export interface LobbyView {
  show(): void;
  hide(): void;
  setStatus(text: string, kind?: StatusKind): void;
}

export function mountLobby(lobby: Lobby, root: HTMLElement): LobbyView {
  const form = query(root, "#lobbyForm", HTMLFormElement);
  const nameInput = query(root, "#playerName", HTMLInputElement);
  const roomsEl = query(root, "#roomList", HTMLElement);
  const statusEl = query(root, "#lobbyStatus", HTMLElement);
  const refreshButton = query(root, "#refreshRooms", HTMLButtonElement);
  const createForm = query(root, "#createRoomForm", HTMLFormElement);
  const createName = query(root, "#newRoomName", HTMLInputElement);

  const setStatus = (text: string, kind: StatusKind = "ok"): void => {
    statusEl.textContent = text;
    statusEl.dataset["kind"] = kind;
  };

  const roomInputs = (): HTMLInputElement[] =>
    [...roomsEl.querySelectorAll("input[name='room']")].filter(
      (input) => input instanceof HTMLInputElement,
    );

  function renderRooms(
    rooms: readonly {
      id: string;
      name: string;
      arenaId: string;
      players: number;
      maxPlayers: number;
    }[],
  ): void {
    const previous = roomInputs().find((input) => input.checked)?.value;
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

    const restore = roomInputs().find((input) => input.value === previous);
    if (restore && !restore.disabled) restore.checked = true;
    else
      roomInputs()
        .find((input) => !input.disabled)
        ?.click();
  }

  lobby.events.on("roomsChanged", ({ rooms }) => renderRooms(rooms));
  lobby.events.on("status", (text) => setStatus(text));
  lobby.events.on("error", (error) =>
    setStatus(`Room refresh failed: ${error.message}`, "error"),
  );

  refreshButton.addEventListener("click", () => {
    statusEl.textContent = "Refreshing…";
    lobby.refresh().catch((error: unknown) => {
      setStatus(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
        "error",
      );
    });
  });

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const name = createName.value.trim();
    if (!name) return;
    try {
      const room = await lobby.createRoom({ name });
      createName.value = "";
      setStatus(`Room "${room.name}" created`);
    } catch (error) {
      setStatus(`Could not create room: ${errorMessage(error)}`, "error");
    }
  };
  createForm.addEventListener("submit", (event) => void onSubmit(event));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomId = new FormData(form).get("room");
    try {
      lobby.join(typeof roomId === "string" ? roomId : "", nameInput.value);
    } catch (error) {
      setStatus(errorMessage(error), "error");
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
    setStatus,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
