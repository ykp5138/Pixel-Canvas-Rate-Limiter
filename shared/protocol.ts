// Constants and message types shared by the client and server.

export const CANVAS_WIDTH = 100;
export const CANVAS_HEIGHT = 100;

// Pixels are stored as an index into this palette (one byte each).
export const PALETTE: readonly string[] = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

// Client IDs are crypto.randomUUID() values, passed as ?userId= on the WebSocket URL.
export const USER_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

// ---------- Client -> Server ----------

export type PlaceMessage = {
  type: "place";
  x: number;
  y: number;
  color: number; // palette index
};

export type ClientMessage = PlaceMessage;

// ---------- Server -> Client ----------

export type SnapshotMessage = {
  type: "snapshot";
  width: number;
  height: number;
  pixels: number[]; // row-major: index = y * width + x
};

export type PixelUpdate = {
  x: number;
  y: number;
  color: number;
};

// Pixels placed since the last batch, oldest first.
export type PixelsMessage = {
  type: "pixels";
  pixels: PixelUpdate[];
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

// Seconds until the user can place again.
export type CooldownMessage = {
  type: "cooldown";
  seconds: number;
};

export type ServerMessage = SnapshotMessage | PixelsMessage | ErrorMessage | CooldownMessage;
