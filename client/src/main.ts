// client/src/main.ts
//
// Browser side of the canvas: connects to the server over a WebSocket, draws the
// snapshot and live pixel updates, and sends "place" messages when you click.

import { PALETTE, type ClientMessage, type ServerMessage } from "../../shared/protocol";

// ---------- DOM lookups ----------

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const canvasEl = mustGet<HTMLCanvasElement>("canvas");
const statusEl = mustGet<HTMLParagraphElement>("status");
const infoEl = mustGet<HTMLParagraphElement>("info");
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
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const socket = new WebSocket(wsUrl);

function sendMessage(message: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// The handler is attached in the same synchronous block that creates the socket,
// so the snapshot can't arrive before we're listening.
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data as string) as ServerMessage;
  switch (message.type) {
    case "snapshot":
      drawSnapshot(message.width, message.height, message.pixels);
      break;
    case "pixel":
      drawPixel(message.x, message.y, message.color);
      break;
    case "error":
      setStatus(`Server rejected that: ${message.message}`, "bad");
      break;
  }
});

socket.addEventListener("open", () => {
  connected = true;
  setStatus("Connected", "ok");
});

socket.addEventListener("close", () => {
  connected = false;
  setStatus("Disconnected. Refresh the page to reconnect.", "bad");
});

// ---------- Input ----------

canvasEl.addEventListener("click", (event) => {
  const pos = gridCoords(event);
  if (!pos || !connected) return;
  sendMessage({ type: "place", x: pos.x, y: pos.y, color: selectedColor });
});

canvasEl.addEventListener("mousemove", (event) => {
  const pos = gridCoords(event);
  infoEl.textContent = pos ? `(${pos.x}, ${pos.y})` : "Hover over the canvas";
});

buildPalette();
