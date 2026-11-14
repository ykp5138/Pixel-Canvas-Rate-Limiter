// server/src/index.ts
//
// HTTP server (serves the page) + WebSocket server (live pixels) on one port.
// The canvas is stored in Redis (see store.ts), so it survives server restarts.

import { createServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PALETTE,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/protocol.js";
import { serveStatic } from "./static.js";
import { connectRedis, loadCanvas, savePixel } from "./store.js";

// `??` means "use 3000 if PORT isn't set". In milestone 3 you'll run several servers on different ports.
const PORT = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const httpServer = createServer(serveStatic);

// Attach the WebSocket server to the HTTP server. Browsers connect to
// ws://localhost:3000. The handshake arrives as an HTTP request, and `ws` upgrades it.
const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send one message to one client. */
function send(socket: WebSocket, message: ServerMessage): void {
  const newMessage = JSON.stringify(message);
  socket.send(newMessage);
}

/** Send one message to every connected client. */
function broadcast(message: ServerMessage): void {
  const newMessage = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(newMessage);
    }
  }
}

/**
 * Check that `value` is an integer with min <= value < maxExclusive.
 * The return type `value is number` is a "type predicate". When this returns true,
 * TypeScript treats `value` as a number in the calling code.
 */
function isIntInRange(value: unknown, min: number, maxExclusive: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value < maxExclusive;
}

/**
 * Turn raw bytes from the network into a validated ClientMessage, or null if invalid.
 * NEVER trust this input: it can be anything a person types into DevTools.
 */
function parseClientMessage(raw: RawData): ClientMessage | null {
  const text = raw.toString();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const { type, x, y, color } = data as Record<string, unknown>;
  if (type !== "place") {
    return null;
  }
  if (!isIntInRange(x, 0, CANVAS_WIDTH) || !isIntInRange(y, 0, CANVAS_HEIGHT) || !isIntInRange(color, 0, PALETTE.length)) {
    return null;
  }
  return { type: "place", x, y, color };
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

// This callback runs once for every new browser connection. `socket` is that one connection.
// All listeners are attached BEFORE the first `await`, so nothing (a message or an error)
// can arrive while this socket has no listener.
wss.on("connection", async (socket) => {
  console.log(`client connected (${wss.clients.size} total)`);

  // Runs every time THIS client sends a message.
  socket.on("message", async (raw) => {
    const msg = parseClientMessage(raw);
    if (msg === null) {
      send(socket, { type: "error", message: "Invalid message" });
      return;
    }

    // Save first, broadcast only if the save succeeded. Without the catch, a Redis
    // failure here would be an unhandled rejection and crash the whole server.
    try {
      await savePixel(msg.x, msg.y, msg.color);
      broadcast({ type: "pixel", x: msg.x, y: msg.y, color: msg.color });
    } catch (err) {
      console.error("Failed to save pixel:", err);
      send(socket, { type: "error", message: "Failed to save pixel" });
    }
  });

  socket.on("close", () => {
    // `ws` removes closed sockets from wss.clients automatically, so no cleanup is needed yet.
    console.log(`client disconnected (${wss.clients.size} remaining)`);
  });

  // Without an error listener, a socket error (like a client vanishing mid-message)
  // becomes an unhandled exception that crashes the whole server.
  socket.on("error", (err) => {
    console.error("socket error:", err.message);
  });

  // Late-joiner snapshot, read from Redis. Sent last, after the listeners above are attached.
  const pixels = await loadCanvas();
  send(socket, { type: "snapshot", width: CANVAS_WIDTH, height: CANVAS_HEIGHT, pixels });
});

// Connect to Redis BEFORE accepting users (top-level await pauses the rest of this file).
await connectRedis();
httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
