import type { CodecName, WelcomeMessage } from "@fpv/shared/protocol";
import type { LatencyOptions } from "@fpv/shared";
import { Connection } from "./connection.ts";
import type { SocketConstructor } from "./connection.ts";

export function defaultSocketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export interface JoinOptions {
  roomId: string;
  name: string;
  codec?: CodecName;
  network?: LatencyOptions;
  url?: string;
  WebSocketImpl?: SocketConstructor;
  timeoutMs?: number;
}

export interface Joined {
  connection: Connection;
  welcome: WelcomeMessage;
}

/**
 * Opens a connection, joins a room and resolves with `{ connection, welcome }`.
 * Rejects if the server answers with an error or closes the socket for good.
 */
export function joinRoom({
  roomId,
  name,
  codec = "json",
  network = {},
  url = defaultSocketUrl(),
  WebSocketImpl,
  timeoutMs = 8000,
}: JoinOptions): Promise<Joined> {
  const connection = new Connection({
    url,
    network,
    ...(WebSocketImpl ? { WebSocketImpl } : {}),
  });
  connection.setSession({ type: "join", roomId, name, codec });

  return new Promise<Joined>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      settle();
    };
    const fail = (message: string): void => {
      connection.close();
      finish(() => reject(new Error(message)));
    };
    const timer = setTimeout(
      () => fail("Timed out while joining the room"),
      timeoutMs,
    );

    cleanups.push(
      connection.on("welcome", (welcome) =>
        finish(() => resolve({ connection, welcome })),
      ),
      connection.on("error", (message) => fail(message.message)),
      connection.lifecycle.on("close", ({ willReconnect, code }) => {
        if (!willReconnect) fail(`Connection closed (${code})`);
      }),
    );

    connection.connect();
  });
}
