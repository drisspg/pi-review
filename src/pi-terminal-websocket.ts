/** Adapt the local HTTP server and WebSocket clients to Pi terminal peers. */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { isLocalOrigin } from "./http.js";
import type { PiTerminalManager, PiTerminalPeer } from "./pi-terminal.js";
import { parsePiTerminalRequest } from "./pi-terminal.js";

export type PiTerminalWebSocketLogger = {
  error: (scope: string, message: string, data?: Record<string, unknown>) => void;
};

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

const HEARTBEAT_INTERVAL_MS = 30_000;

type HeartbeatWebSocket = WebSocket & { isAlive?: boolean };

/** Wire the Pi terminal WebSocket endpoint onto the existing HTTP server. */
export function attachPiTerminalWebSocketServer(server: HttpServer, manager: PiTerminalManager, logger: PiTerminalWebSocketLogger): () => void {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // An unhandled 'error' on a raw upgrade socket (e.g. ECONNRESET mid-handshake) would crash the process.
    socket.on("error", () => socket.destroy());
    const terminalRequest = parsePiTerminalRequest(request.url ?? "", request.headers.host);
    if (terminalRequest == null) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (!isLocalOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket: HeartbeatWebSocket) => {
      webSocket.isAlive = true;
      webSocket.on("pong", () => {
        webSocket.isAlive = true;
      });
      void manager.attach(peerForWebSocket(webSocket), terminalRequest);
    });
  };
  server.on("upgrade", onUpgrade);
  webSocketServer.on("error", (error) => logger.error("pi-terminal", "websocket error", { error: error.message }));
  // Terminate half-open clients so a dead socket cannot hold flow control (and the pty) paused forever.
  const heartbeat = setInterval(() => {
    for (const client of webSocketServer.clients as Set<HeartbeatWebSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  return () => {
    clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    webSocketServer.close();
  };
}
