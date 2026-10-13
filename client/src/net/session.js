import { Connection } from "./connection.js";

export function defaultSocketUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

/**
 * Opens a connection, joins a room and resolves with `{ connection, welcome }`.
 * Rejects if the server answers with an error or closes the socket for good.
 */
export function joinRoom({
  roomId,
  name,
  url = defaultSocketUrl(),
  WebSocketImpl,
  timeoutMs = 8000,
}) {
  const connection = new Connection({ url, WebSocketImpl });
  connection.setSession({ type: "join", roomId, name });

  return new Promise((resolve, reject) => {
    const cleanups = [];
    const finish = (settle, value) => {
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      settle(value);
    };
    const fail = (message) => {
      connection.close();
      finish(reject, new Error(message));
    };
    const timer = setTimeout(
      () => fail("Timed out while joining the room"),
      timeoutMs,
    );

    cleanups.push(
      connection.on("welcome", (welcome) =>
        finish(resolve, { connection, welcome }),
      ),
    );
    cleanups.push(
      connection.on("error", (message) =>
        fail(message.message ?? "Server error"),
      ),
    );
    const onClose = (event) => {
      if (!event.detail.willReconnect)
        fail(`Connection closed (${event.detail.code})`);
    };
    connection.addEventListener("close", onClose);
    cleanups.push(() => connection.removeEventListener("close", onClose));

    connection.connect();
  });
}
