// shared/protocol.ts
//
// The "contract" between browser and server: canvas constants and the exact
// shape of every message sent over the WebSocket. Both sides import this file,
// so if a message format changes, TypeScript flags every place that needs updating.

export const CANVAS_WIDTH = 100;
export const CANVAS_HEIGHT = 100;

// 16 colors. A pixel is stored as an index into this array (0-15), not as a hex string,
// so each pixel fits in one byte.
export const PALETTE: readonly string[] = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

// ---------- Browser -> Server ----------

export type PlaceMessage = {
  type: "place";
  x: number;
  y: number;
  color: number; // index into PALETTE
};

// A union with one member for now; more message types can be added later with `|`.
export type ClientMessage = PlaceMessage;

// ---------- Server -> Browser ----------

export type SnapshotMessage = {
  type: "snapshot";
  width: number;
  height: number;
  pixels: number[]; // row-major: pixel (x, y) is at index y * width + x
};

export type PixelMessage = {
  type: "pixel";
  x: number;
  y: number;
  color: number;
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type ServerMessage = SnapshotMessage | PixelMessage | ErrorMessage;
