// server/src/store.ts
//
// All Redis access lives in this file. The rest of the server calls these functions
// and never talks to Redis directly (like a @Repository class in Spring).
//
// How the canvas is stored: ONE Redis string under the key "canvas", 10,000 bytes long.
// Byte number (y * CANVAS_WIDTH + x) holds that pixel's palette index (0-15).
// It's the same layout as the Uint8Array from milestone 1, now living in Redis.

import { createClient } from "redis";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../../shared/protocol.js";

// Where Redis is. Defaults to your Docker container on localhost. In milestone 4
// (docker-compose) this will be set to something like "redis://redis:6379".
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const CANVAS_KEY = "canvas";

// The client object: your connection to Redis (like a JDBC Connection).
// Created here, but not connected until connectRedis() is called.
const redis = createClient({ url: REDIS_URL });

// Without an error listener, a lost Redis connection would crash the whole server
// (same reason as socket.on("error") in index.ts). The client also reconnects on its own.
redis.on("error", (err: Error) => {
  console.error("Redis error:", err.message);
});

/** Open the connection. Called once at startup, before the server accepts users. */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  console.log(`connected to Redis at ${REDIS_URL}`);
}

/** Convert (x, y) to a byte offset in the canvas string (moved here from index.ts). */
function offsetOf(x: number, y: number): number {
  return y * CANVAS_WIDTH + x;
}

/** Store one pixel's color in Redis. */
export async function savePixel(x: number, y: number, color: number): Promise<void> {
  // SETRANGE overwrites one byte in place. String.fromCharCode(5) is the single byte 5
  // (not "5", which is character code 53). Missing bytes before the offset become 0 (white).
  await redis.setRange(CANVAS_KEY, offsetOf(x, y), String.fromCharCode(color));
}

/** Read the whole canvas from Redis as an array of palette indexes (for snapshots). */
export async function loadCanvas(): Promise<number[]> {
  const pixels = new Array<number>(CANVAS_WIDTH * CANVAS_HEIGHT).fill(0); // all white
  const raw = await redis.get(CANVAS_KEY);
  if (raw) {
    for (let i = 0; i < raw.length; i++) {
      pixels[i] = raw.charCodeAt(i);
    }
  }
  // The Redis string is only as long as the furthest byte ever written, so any
  // pixels beyond raw.length keep their default 0 (white).
  return pixels;
}
