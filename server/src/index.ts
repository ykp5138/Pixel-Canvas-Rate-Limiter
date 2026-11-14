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
  USER_ID_PATTERN,
} from "../../shared/protocol.js";
import { serveStatic } from "./static.js";
import {
  connectRedis,
  loadCanvas,
  savePixel,
  tryClaimCooldown,
  getCooldownRemaining,
  onPixel,
  publishPixel,
  COOLDOWN_SECONDS,
} from "./store.js";

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

// One user can have several tabs open, i.e. several sockets. This map lets us find
// all of them: userId -> the set of that user's open sockets on THIS server.
// (Java equivalent: Map<String, Set<WebSocket>> socketsByUser = new HashMap<>();)
const socketsByUser = new Map<string, Set<WebSocket>>();

/** Send one message to every open socket (tab) belonging to one user. */
function sendToUser(userId: string, message: ServerMessage): void {
  const sockets = socketsByUser.get(userId);
  if (sockets === undefined) {
    return;
  }
  const newMessage = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(newMessage);
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
wss.on("connection", async (socket, request) => {
  console.log(`client connected (${wss.clients.size} total)`);

  // Identify the user from the URL (ws://host/?userId=...). The ID goes into a Redis key,
  // so anything that isn't a well-formed UUID is refused (1008 = policy violation).
  const userId = new URL(request.url ?? "/", "http://localhost").searchParams.get("userId");
  if (userId === null || !USER_ID_PATTERN.test(userId)) {
    socket.close(1008, "Missing or invalid user ID");
    return;
  }

  // Register this socket under its user (get-or-create the user's set).
  let sockets = socketsByUser.get(userId);
  if (sockets === undefined) {
    sockets = new Set<WebSocket>();
    socketsByUser.set(userId, sockets);
  }
  sockets.add(socket);

  // Runs every time THIS client sends a message.
  socket.on("message", async (raw) => {
    const msg = parseClientMessage(raw);
    if (msg === null) {
      send(socket, { type: "error", message: "Invalid message" });
      return;
    }

    // Order: claim cooldown -> save -> broadcast -> tell all this user's tabs their cooldown.
    // Claiming first ("reserve before you consume") means a second request can't slip
    // in between saving and starting the cooldown. Without the catch, a Redis failure
    // here would be an unhandled rejection and crash the whole server.
    try {
      const allowed = await tryClaimCooldown(userId);
      if (!allowed) {
        const secondsLeft = await getCooldownRemaining(userId);
        send(socket, { type: "cooldown", seconds: secondsLeft });
        return;
      }
      await savePixel(msg.x, msg.y, msg.color);
      // No broadcast here: this server hears its own message through onPixel (below)
      // and broadcasts it then, like every other server. One delivery path, no duplicates.
      await publishPixel({ x: msg.x, y: msg.y, color: msg.color });
      sendToUser(userId, { type: "cooldown", seconds: COOLDOWN_SECONDS });
    } catch (err) {
      console.error("Failed to save pixel:", err);
      send(socket, { type: "error", message: "Failed to save pixel" });
    }
  });

  socket.on("close", () => {
    // `ws` removes closed sockets from wss.clients automatically, but socketsByUser is
    // OUR map, so we must clean it up ourselves (otherwise it leaks memory forever).
    socketsByUser.get(userId)?.delete(socket);
    if (socketsByUser.get(userId)?.size === 0) {
      socketsByUser.delete(userId);
    }
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

  // If this user refreshed mid-cooldown, show them the time left.
  const secondsLeft = await getCooldownRemaining(userId);
  if (secondsLeft > 0) {
    send(socket, { type: "cooldown", seconds: secondsLeft });
  }
});

// Connect to Redis BEFORE accepting users (top-level await pauses the rest of this file).
await connectRedis();

// Pixels from ALL servers (including this one) arrive here; forward them to this
// server's tabs. Subscribed BEFORE listen(), so no user can connect while we're deaf.
await onPixel((pixel) => {
  broadcast({ type: "pixel", ...pixel });
});

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
