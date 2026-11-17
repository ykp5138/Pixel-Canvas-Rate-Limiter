// Prometheus metrics, served at /metrics.

import { type ServerResponse, createServer } from "node:http";
import { register, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";

// CPU, memory, event loop lag, GC
collectDefaultMetrics();

export const wsConnections = new Gauge({
  name: "ws_connections",
  help: "Number of open WebSocket connections",
});

export const pixelsPlacedTotal = new Counter({
  name: "pixels_placed_total",
  help: "Total number of pixels placed",
});

export const pixelsRejectedTotal = new Counter({
  name: "pixels_rejected_total",
  help: "Total number of pixels rejected",
  labelNames: ["reason"],
});

export const placeDurationSeconds = new Histogram({
  name: "place_duration_seconds",
  help: "Duration of place requests in seconds",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export async function serveMetrics(res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": register.contentType });
  res.end(await register.metrics());
}


export function startMetricsServer(port: number): void {
  const server = createServer((req, res) => {
    if(req.url === "/metrics"){
      void serveMetrics(res);
      return;
    } else {
      res.writeHead(404, {"Content-Type": "text/plain"});
      res.end("Not found");
      return;
    }
  });
  server.listen(port, () => {
    console.log(`metrics on http://localhost:${port}/metrics`);
  });
};
