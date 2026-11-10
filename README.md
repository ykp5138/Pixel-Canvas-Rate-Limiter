# Pixel Canvas

A real-time collaborative pixel canvas. Users place one pixel at a time on a shared grid, subject to a per-user cooldown, and every placed pixel appears live for everyone.

The canvas is the visible part. Most of the work is in the infrastructure behind it: WebSockets, Redis, load testing, monitoring, containers, Kubernetes, and CI/CD.

## Status

Milestone 1 (single server, live sync between browser tabs): in progress.

## Running locally

Requires Node.js 22 or later.

```sh
npm install
npm run dev
```

## Project layout

```
server/   Node.js server (TypeScript)
client/   Browser canvas (TypeScript, bundled with esbuild)
```
