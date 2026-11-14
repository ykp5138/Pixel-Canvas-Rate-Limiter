// Serves index.html and the client bundle.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const CLIENT_DIR = path.resolve(process.cwd(), "client");

// Explicit whitelist so arbitrary paths can't be read from disk.
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
    res.end(`Could not read ${route.file}. Has the client been built?`);
  }
}
