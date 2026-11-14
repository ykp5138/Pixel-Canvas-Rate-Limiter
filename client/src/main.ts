// client/src/main.ts
//
// Browser side of the canvas: connects to the server over a WebSocket, draws the
// snapshot and live pixel updates, sends "place" messages when you click, and shows
// the cooldown countdown the server tells us about.

import { PALETTE, type ClientMessage, type PixelMessage, type ServerMessage } from "../../shared/protocol";

// ---------- User identity ----------
// A random ID made on the first visit and kept in localStorage, so every tab in this
// browser shares one ID (and therefore one cooldown). Known weakness: clearing site
// data gives you a new ID. Fine for now; the cheating bots in milestone 5 will show it.

function getOrCreateUserId(): string {
  const KEY = "pixel-canvas-user-id";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // localStorage can be blocked (private mode, strict settings). Use a per-tab ID instead.
    return crypto.randomUUID();
  }
}

const userId = getOrCreateUserId();

// ---------- DOM lookups ----------

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const canvasEl = mustGet<HTMLCanvasElement>("canvas");
const statusEl = mustGet<HTMLParagraphElement>("status");
const infoEl = mustGet<HTMLParagraphElement>("info");
const cooldownEl = mustGet<HTMLParagraphElement>("cooldown");
const paletteEl = mustGet<HTMLDivElement>("palette");

const ctx = canvasEl.getContext("2d");
if (!ctx) throw new Error("Canvas 2D context not supported");

// ---------- State ----------

let selectedColor = 3; // start with near-black
let connected = false;

function setStatus(text: string, kind: "ok" | "bad" | "neutral"): void {
  statusEl.textContent = text;
  statusEl.className = kind === "neutral" ? "" : kind;
}

// ---------- Cooldown display ----------
// This is only for the user's convenience. The SERVER enforces the real cooldown in
// Redis; skipping this check from DevTools just gets you a rejection from the server.

let cooldownUntil = 0; // timestamp (ms) when the user may place again
let cooldownTimer: number | undefined;

function startCooldown(seconds: number): void {
  cooldownUntil = Date.now() + seconds * 1000;
  window.clearInterval(cooldownTimer);
  renderCooldown();
  cooldownTimer = window.setInterval(renderCooldown, 250);
}

function renderCooldown(): void {
  const msLeft = cooldownUntil - Date.now();
  if (msLeft <= 0) {
    window.clearInterval(cooldownTimer);
    cooldownEl.textContent = "Ready: click to place a pixel";
    cooldownEl.className = "ready";
    canvasEl.classList.remove("cooling");
    return;
  }
  cooldownEl.textContent = `Next pixel in ${Math.ceil(msLeft / 1000)}s`;
  cooldownEl.className = "";
  canvasEl.classList.add("cooling");
}

// ---------- Drawing ----------
// The <canvas> element is exactly 1 canvas pixel per grid cell (100x100).
// CSS scales it up, and `image-rendering: pixelated` keeps the edges sharp.

function drawPixel(x: number, y: number, color: number): void {
  ctx!.fillStyle = PALETTE[color] ?? "#000000";
  ctx!.fillRect(x, y, 1, 1);
}

function drawSnapshot(width: number, height: number, pixels: number[]): void {
  canvasEl.width = width;
  canvasEl.height = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      drawPixel(x, y, pixels[y * width + x] ?? 0);
    }
  }
}

/** Convert a mouse position on the (scaled) canvas element to grid coordinates. */
function gridCoords(event: MouseEvent): { x: number; y: number } | null {
  const rect = canvasEl.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvasEl.width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvasEl.height);
  if (x < 0 || y < 0 || x >= canvasEl.width || y >= canvasEl.height) return null;
  return { x, y };
}

// ---------- Palette ----------

function buildPalette(): void {
  PALETTE.forEach((hex, index) => {
    const button = document.createElement("button");
    button.className = "swatch";
    button.style.background = hex;
    button.title = `Color ${index} (${hex})`;
    button.setAttribute("aria-label", `Color ${hex}`);
    if (index === selectedColor) button.classList.add("selected");
    button.addEventListener("click", () => {
      selectedColor = index;
      for (const el of paletteEl.children) el.classList.remove("selected");
      button.classList.add("selected");
    });
    paletteEl.appendChild(button);
  });
}

// ---------- Networking ----------

// Build the WebSocket URL from the page's own address, so this works on localhost
// now and on a real domain (with wss:// over HTTPS) at deployment time.
// The user ID rides along as a query parameter: ws://localhost:3000/?userId=...
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?userId=${encodeURIComponent(userId)}`;
const socket = new WebSocket(wsUrl);

function sendMessage(message: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// The handler is attached in the same synchronous block that creates the socket,
// so the snapshot can't arrive before we're listening.
// With multiple servers, a "pixel" message can arrive BEFORE our snapshot (the server
// reads the snapshot over one Redis connection and hears pixels over another, so their
// order isn't guaranteed). If we drew it immediately, the snapshot would then paint over
// it. So pixels that arrive early wait in a queue and are replayed after the snapshot.
let haveSnapshot = false;
const earlyPixels: PixelMessage[] = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data as string) as ServerMessage;
  switch (message.type) {
    case "snapshot":
      drawSnapshot(message.width, message.height, message.pixels);
      for (const p of earlyPixels) drawPixel(p.x, p.y, p.color);
      earlyPixels.length = 0;
      haveSnapshot = true;
      break;
    case "pixel":
      if (haveSnapshot) drawPixel(message.x, message.y, message.color);
      else earlyPixels.push(message);
      break;
    case "error":
      setStatus(`Server rejected that: ${message.message}`, "bad");
      break;
    case "cooldown":
      startCooldown(message.seconds);
      break;
  }
});

socket.addEventListener("open", () => {
  connected = true;
  setStatus("Connected", "ok");
});

socket.addEventListener("close", (event) => {
  connected = false;
  const reason = event.reason ? ` (${event.reason})` : "";
  setStatus(`Disconnected${reason}. Refresh the page to reconnect.`, "bad");
});

// ---------- Input ----------

canvasEl.addEventListener("click", (event) => {
  const pos = gridCoords(event);
  if (!pos || !connected) return;
  if (Date.now() < cooldownUntil) return; // UX only; the server enforces it for real
  sendMessage({ type: "place", x: pos.x, y: pos.y, color: selectedColor });
});

canvasEl.addEventListener("mousemove", (event) => {
  const pos = gridCoords(event);
  infoEl.textContent = pos ? `(${pos.x}, ${pos.y})` : "Hover over the canvas";
});

buildPalette();
renderCooldown();
