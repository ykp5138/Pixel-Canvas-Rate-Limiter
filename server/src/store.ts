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
// Connection errors (like ECONNREFUSED when Redis is down) often have an empty
// .message, so log the error code too.
redis.on("error", (err: Error & { code?: string }) => {
  console.error("Redis error:", err.code ?? "", err.message);
});

// A SECOND connection, used only for listening to pub/sub channels. Once a Redis
// connection subscribes, it switches into "subscriber mode" and can't run normal
// commands (GET, SET, ...) anymore. So subscribing gets its own connection.
// duplicate() = "same settings, new connection".
const subscriber = redis.duplicate();
subscriber.on("error", (err: Error & { code?: string }) => {
  console.error("Redis subscriber error:", err.code ?? "", err.message);
});

/** Open both connections. Called once at startup, before the server accepts users. */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  await subscriber.connect();
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

// ---------------------------------------------------------------------------
// Cooldown (the rate limiter)
// ---------------------------------------------------------------------------
// One key per user, e.g. "cooldown:3f2a...". If the key exists, the user is cooling down.
// Redis deletes it automatically after COOLDOWN_SECONDS (that's the EX option).

export const COOLDOWN_SECONDS = 30;

function cooldownKey(userId: string): string {
  return `cooldown:${userId}`;
}

/**
 * Try to start this user's cooldown.
 * Returns true  -> no cooldown was active, so we just started one: ALLOW the pixel.
 * Returns false -> a cooldown is already active: REJECT the pixel.
 * Check and set happen in ONE atomic Redis command, so two simultaneous requests
 * from the same user can never both get `true`.
 */
export async function tryClaimCooldown(userId: string): Promise<boolean> {
  // SET cooldown:<userId> 1 NX EX 30. Redis replies "OK" if it set the key, null if it existed.
  const result = await redis.set(cooldownKey(userId), "1", {
    condition: "NX", // only if Not eXists
    expiration: { type: "EX", value: COOLDOWN_SECONDS }, // auto-delete after 30s
  });
  return result === "OK";
}

/** How many seconds until this user may place again (0 if they can place now). */
export async function getCooldownRemaining(userId: string): Promise<number> {
  const ttl = await redis.ttl(cooldownKey(userId));
  return Math.max(ttl, 0);
}

// ---------------------------------------------------------------------------
// Pub/sub: how servers tell each other about new pixels
// ---------------------------------------------------------------------------
// Every server subscribes to PIXEL_CHANNEL. When any server places a pixel, it
// publishes it there, and Redis delivers it to EVERY subscribed server, including
// the one that published it.

const PIXEL_CHANNEL = "canvas:pixels";

/** What travels over the channel: just the pixel. */
export type PixelEvent = { x: number; y: number; color: number };

/** Announce a new pixel to every server (including this one). */
export async function publishPixel(pixel: PixelEvent): Promise<void> {
  const message = JSON.stringify(pixel);
  await redis.publish(PIXEL_CHANNEL, message);
}

/**
 * Register a function to run whenever ANY server publishes a pixel.
 * Called once at startup.
 */
export async function onPixel(handler: (pixel: PixelEvent) => void): Promise<void> {
  // Messages come from our own servers, so a type assertion (not full validation) is fine.
  await subscriber.subscribe(PIXEL_CHANNEL, (message) => {
    const pixel = JSON.parse(message) as PixelEvent;
    handler(pixel);
  });
}
