// Browser client: draws the canvas, sends placements, shows the cooldown.

import { PALETTE, type ClientMessage, type PixelUpdate, type ServerMessage } from "../../shared/protocol";

// ---------- User ID ----------

// Stored in localStorage so all tabs in a browser share one ID (and one cooldown).
function getOrCreateUserId(): string {
  const KEY = "pixel-canvas-user-id";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // localStorage can be blocked (e.g. private mode); fall back to a per-tab ID.
    return crypto.randomUUID();
  }
}

const userId = getOrCreateUserId();

// ---------- DOM ----------

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

let selectedColor = 3;
let connected = false;

function setStatus(text: string, kind: "ok" | "bad" | "neutral"): void {
  statusEl.textContent = text;
  statusEl.className = kind === "neutral" ? "" : kind;
}

// ---------- Cooldown display (the server enforces the actual cooldown) ----------

let cooldownUntil = 0; // ms timestamp
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

// The canvas is 100x100 real pixels, scaled up with CSS.
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

/** Mouse position -> grid cell, or null if outside the canvas. */
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

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?userId=${encodeURIComponent(userId)}`;
const socket = new WebSocket(wsUrl);

function sendMessage(message: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// Pixels can arrive before the snapshot; queue them and replay after it's drawn.
let haveSnapshot = false;
const earlyPixels: PixelUpdate[] = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data as string) as ServerMessage;
  switch (message.type) {
    case "snapshot":
      drawSnapshot(message.width, message.height, message.pixels);
      for (const p of earlyPixels) drawPixel(p.x, p.y, p.color);
      earlyPixels.length = 0;
      haveSnapshot = true;
      break;
    case "pixels":
      if (haveSnapshot) for (const p of message.pixels) drawPixel(p.x, p.y, p.color);
      else earlyPixels.push(...message.pixels);
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
  if (Date.now() < cooldownUntil) return;
  sendMessage({ type: "place", x: pos.x, y: pos.y, color: selectedColor });
});

canvasEl.addEventListener("mousemove", (event) => {
  const pos = gridCoords(event);
  infoEl.textContent = pos ? `(${pos.x}, ${pos.y})` : "Hover over the canvas";
});

buildPalette();
renderCooldown();
