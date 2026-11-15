// HTTP + WebSocket server. Canvas state lives in Redis (see store.ts).

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
import { serveMetrics, wsConnections, pixelsPlacedTotal, pixelsRejectedTotal, placeDurationSeconds } from "./metrics.js";
import {
  connectRedis,
  loadCanvas,
  savePixel,
  tryClaimCooldown,
  getCooldownRemaining,
  onPixel,
  publishPixel,
  publishCooldown,
  onCooldown,
  COOLDOWN_SECONDS,
} from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);

const httpServer = createServer((req, res) => {
  if (req.url === "/metrics") {
    void serveMetrics(res);
    return;
  }
  void serveStatic(req, res);
});
const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send one message to one client. */
function send(socket: WebSocket, message: ServerMessage): void {
  const newMessage = JSON.stringify(message);
  socket.send(newMessage);
}

/** Send one message to every client connected to this server. */
function broadcast(message: ServerMessage): void {
  const newMessage = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(newMessage);
    }
  }
}

// userId -> that user's open sockets (tabs) on this server
const socketsByUser = new Map<string, Set<WebSocket>>();

/** Send one message to every tab a user has open on this server. */
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

function isIntInRange(value: unknown, min: number, maxExclusive: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value < maxExclusive;
}

/** Parse and validate a message from a client. Returns null if invalid. */
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
// Connections
// ---------------------------------------------------------------------------

wss.on("connection", async (socket, request) => {
  console.log(`client connected (${wss.clients.size} total)`);

  // userId comes from the URL: ws://host/?userId=...
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
  wsConnections.inc();

  // Runs every time THIS client sends a message.
  socket.on("message", async (raw) => {
    const stopTimer = placeDurationSeconds.startTimer();
    const msg = parseClientMessage(raw);
    if (msg === null) {
      pixelsRejectedTotal.inc({ reason: "invalid" });
      send(socket, { type: "error", message: "Invalid message" });
      return;
    }

    try {
      // Claim the cooldown before saving so concurrent requests can't both get through.
      const allowed = await tryClaimCooldown(userId);
      if (!allowed) {
        pixelsRejectedTotal.inc({ reason: "cooldown" });
        const secondsLeft = await getCooldownRemaining(userId);
        send(socket, { type: "cooldown", seconds: secondsLeft });
        return;
      }
      await savePixel(msg.x, msg.y, msg.color);
      // Delivered to clients by the onPixel / onCooldown subscribers below.
      await publishPixel({ x: msg.x, y: msg.y, color: msg.color });
      await publishCooldown({ userId, seconds: COOLDOWN_SECONDS });
      pixelsPlacedTotal.inc();
      stopTimer();
    } catch (err) {
      pixelsRejectedTotal.inc({ reason: "error" });
      console.error("Failed to save pixel:", err);
      send(socket, { type: "error", message: "Failed to save pixel" });
    }
  });

  socket.on("close", () => {
    wsConnections.dec();
    socketsByUser.get(userId)?.delete(socket);
    if (socketsByUser.get(userId)?.size === 0) {
      socketsByUser.delete(userId);
    }
    console.log(`client disconnected (${wss.clients.size} remaining)`);
  });

  socket.on("error", (err) => {
    console.error("socket error:", err.message);
  });

  // Listeners are attached above, before the first await.
  const pixels = await loadCanvas();
  send(socket, { type: "snapshot", width: CANVAS_WIDTH, height: CANVAS_HEIGHT, pixels });

  // Resume the countdown if the user refreshed mid-cooldown.
  const secondsLeft = await getCooldownRemaining(userId);
  if (secondsLeft > 0) {
    send(socket, { type: "cooldown", seconds: secondsLeft });
  }
});

// ---------------------------------------------------------------------------
// Startup: connect and subscribe before accepting connections
// ---------------------------------------------------------------------------

await connectRedis();

await onPixel((pixel) => {
  broadcast({ type: "pixel", ...pixel });
});

await onCooldown((event) => {
  sendToUser(event.userId, { type: "cooldown", seconds: event.seconds });
});

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
