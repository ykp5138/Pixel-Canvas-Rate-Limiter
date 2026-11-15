# Load test results

All users are simulated (k6 virtual users). Numbers are from a single laptop, with the load generator (k6) running on the same machine as the system under test, so they show relative behavior, not production capacity.

**Machine:** AMD Ryzen 9 8945HS (8 cores / 16 threads), 32 GB RAM, Windows 11, Docker Desktop (WSL2, 16 CPUs / 16 GB).
**Mix:** 2 lurkers : 1 placer (`BOTS=lurker,placer`), 30 s cooldown.

## Runs

| # | Date | Replicas | Peak simulated users | Profile | Round trip p95 (client) | Snapshot p95 (client) | Server place p95 | Max event loop lag p99 | Busiest server CPU (cores) | Msgs delivered / sec | Errors | Notes |
|---|------|----------|------|---------|------|------|------|------|------|------|------|-------|
| 0 | 2026-11-15 | 3 | 1,500 | ramp, 4 steps × 30 s | 97 ms | 53 ms | 195 ms | 93 ms | 0.59 | ~9,900 avg | 1 client send on a closing socket | Calibration run. Lag rose before CPU did. |

## Observations
