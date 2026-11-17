// All Redis access: canvas storage, cooldowns, and pub/sub between servers.
//
// The canvas is a single Redis string ("canvas"), one byte per pixel.
// Byte (y * CANVAS_WIDTH + x) holds that pixel's palette index.

import { createClient } from "redis";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../../shared/protocol.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const CANVAS_KEY = "canvas";

const REDIS_TIMEOUT_MS = Number(process.env.REDIS_TIMEOUT_MS ?? 2000)
const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true, commandOptions: { timeout: REDIS_TIMEOUT_MS } });

redis.on("error", (err: Error & { code?: string }) => {
  // Connection errors like ECONNREFUSED often have an empty message.
  console.error("Redis error:", err.code ?? "", err.message);
});

// Separate connection for pub/sub, since a subscribed connection can't run other commands.
const subscriber = redis.duplicate();
subscriber.on("error", (err: Error & { code?: string }) => {
  console.error("Redis subscriber error:", err.code ?? "", err.message);
});

export async function connectRedis(): Promise<void> {
  await redis.connect();
  await subscriber.connect();
  console.log(`connected to Redis at ${REDIS_URL}`);
}

export async function disconnectRedis(): Promise<void> {
  await redis.close();
  await subscriber.close();
}

export function isRedisReady(): boolean {
  if(redis.isReady && subscriber.isReady){
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

function offsetOf(x: number, y: number): number {
  return y * CANVAS_WIDTH + x;
}

export async function savePixel(x: number, y: number, color: number): Promise<void> {
  await redis.setRange(CANVAS_KEY, offsetOf(x, y), String.fromCharCode(color));
}

export async function loadCanvas(): Promise<number[]> {
  const pixels = new Array<number>(CANVAS_WIDTH * CANVAS_HEIGHT).fill(0);
  const raw = await redis.get(CANVAS_KEY);
  // The string only extends to the furthest pixel written; the rest stay 0 (white).
  if (raw) {
    for (let i = 0; i < raw.length; i++) {
      pixels[i] = raw.charCodeAt(i);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

export const COOLDOWN_SECONDS = 30;

function cooldownKey(userId: string): string {
  return `cooldown:${userId}`;
}

/** Returns true if the user was not on cooldown (and starts one), false otherwise. */
export async function tryClaimCooldown(userId: string): Promise<boolean> {
  // SET NX EX checks and sets in one atomic command.
  const result = await redis.set(cooldownKey(userId), "1", {
    condition: "NX",
    expiration: { type: "EX", value: COOLDOWN_SECONDS },
  });
  return result === "OK";
}

/** Seconds left on the user's cooldown, or 0. */
export async function getCooldownRemaining(userId: string): Promise<number> {
  const ttl = await redis.ttl(cooldownKey(userId));
  return Math.max(ttl, 0);
}

// ---------------------------------------------------------------------------
// Pub/sub between servers
// ---------------------------------------------------------------------------

const PIXEL_CHANNEL = "canvas:pixels";
const COOLDOWN_CHANNEL = "canvas:cooldowns";

export type PixelEvent = { x: number; y: number; color: number };
export type CooldownEvent = { userId: string; seconds: number };

export async function publishPixel(pixel: PixelEvent): Promise<void> {
  const message = JSON.stringify(pixel);
  await redis.publish(PIXEL_CHANNEL, message);
}

export async function onPixel(handler: (pixel: PixelEvent) => void): Promise<void> {
  await subscriber.subscribe(PIXEL_CHANNEL, (message) => {
    const pixel = JSON.parse(message) as PixelEvent;
    handler(pixel);
  });
}

export async function publishCooldown(event: CooldownEvent): Promise<void> {
  const message = JSON.stringify(event);
  await redis.publish(COOLDOWN_CHANNEL, message);
}

export async function onCooldown(handler: (event: CooldownEvent) => void): Promise<void> {
  await subscriber.subscribe(COOLDOWN_CHANNEL, (message) => {
    const event = JSON.parse(message) as CooldownEvent;
    handler(event);
  });
}
