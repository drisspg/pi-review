/** Adapt the local HTTP server and WebSocket clients to Pi terminal peers. */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import type { PiTerminalManager, PiTerminalPeer } from "./pi-terminal.js";
import { parsePiTerminalRequest } from "./pi-terminal.js";

export type PiTerminalWebSocketLogger = {
  error: (scope: string, message: string, data?: Record<string, unknown>) => void;
};

/** Accept browser connections only from the local Pi Review application. */
export function isLocalTerminalOrigin(origin: string | undefined): boolean {
  if (origin == null) return true;
  try {
    return ["127.0.0.1", "::1", "localhost"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function peerForWebSocket(webSocket: WebSocket): PiTerminalPeer {
  return {
    send(message) {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(message));
    },
    close(code, reason) {
      if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) webSocket.close(code, reason);
    },
    onMessage(listener) {
      webSocket.on("message", (data) => listener(data.toString()));
    },
    onClose(listener) {
      webSocket.on("close", listener);
    },
  };
}

/** Wire the Pi terminal WebSocket endpoint onto the existing HTTP server. */
export function attachPiTerminalWebSocketServer(server: HttpServer, manager: PiTerminalManager, logger: PiTerminalWebSocketLogger): () => void {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const terminalRequest = parsePiTerminalRequest(request.url ?? "", request.headers.host);
    if (terminalRequest == null) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (!isLocalTerminalOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      void manager.attach(peerForWebSocket(webSocket), terminalRequest);
    });
  };
  server.on("upgrade", onUpgrade);
  webSocketServer.on("error", (error) => logger.error("pi-terminal", "websocket error", { error: error.message }));
  return () => {
    server.off("upgrade", onUpgrade);
    webSocketServer.close();
  };
}
