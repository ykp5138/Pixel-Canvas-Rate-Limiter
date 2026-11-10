// server/src/static.ts
//
// Serves the browser files (index.html and the bundled JS) over plain HTTP.
// This is boilerplate: it isn't part of the system design.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

// npm scripts always run from the project root, so cwd is pixel-canvas/.
const CLIENT_DIR = path.resolve(process.cwd(), "client");

// Only these exact URL paths are served. A whitelist is safer than mapping any
// URL to a file on disk, which would allow "path traversal" (GET /../../secret.txt).
const ROUTES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/dist/main.js": { file: "dist/main.js", contentType: "text/javascript; charset=utf-8" },
  "/dist/main.js.map": { file: "dist/main.js.map", contentType: "application/json; charset=utf-8" },
};

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
  const route = ROUTES[urlPath];

  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const body = await readFile(path.join(CLIENT_DIR, route.file));
    res.writeHead(200, { "Content-Type": route.contentType, "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Could not read ${route.file}. Has the client been built? (npm run dev does this)`);
  }
}
