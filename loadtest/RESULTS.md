# Load test results

All users are simulated (k6 virtual users). Numbers are from a single laptop, with the load generator (k6) running on the same machine as the system under test, so they show relative behavior, not production capacity.

**Machine:** AMD Ryzen 9 8945HS (8 cores / 16 threads), 32 GB RAM, Windows 11, Docker Desktop (WSL2, 16 CPUs / 16 GB).
**Mix:** 2 lurkers : 1 placer (`BOTS=lurker,placer`), 30 s cooldown.

## Runs

Runs 0–5: before batching (each pixel broadcast immediately). Runs 6–9: after batching (commit `03d1cbe`, pixels flushed every 100 ms). In runs 6–9, "Msgs delivered / sec" counts batch messages, so it drops even though the same pixels are delivered.

| # | Date | Replicas | Peak simulated users | Profile | Round trip p95 (client) | Snapshot p95 (client) | Server place p95 | Max event loop lag p99 | Busiest server CPU (cores) | Msgs delivered / sec | Errors | Notes |
|---|------|----------|------|---------|------|------|------|------|------|------|------|-------|
| 0 | 2026-11-15 | 3 | 1,500 | ramp, 4 steps × 30 s | 97 ms | 53 ms | 195 ms | 93 ms | 0.59 | ~9,900 avg | 1 client send on a closing socket | Calibration run. Lag rose before CPU did. |
| 1 | 2026-11-15 | 3 | 1,500 | ramp, 5 × 1 min | 82 ms | 44 ms | 144 ms | 97 ms | 0.55 | ~23,000 | 0 | Healthy throughout. Connections balanced 510/506/507. k6 used ~3 of 16 cores. |
| 2 | 2026-11-15 | 3 | 3,000 | ramp, 5 × 1 min | 2.4 s | 12.4 s | > 1 s (above top bucket) | 1.14 s | 1.02 | ~71,000 | 0 server errors; 37 pixels never confirmed | Fine through 2,400 users; collapsed at 3,000 (CPU hit 1.0, connect p95 12 s). k6 CPU not captured. |
| 3 | 2026-11-15 | 3 | 4,500 target, ~2,870 connected | ramp, 5 × 1 min | 16.4 s | 43.9 s | > 1 s (above top bucket) | 5.3 s | 1.07 | ~72,000, then fell to ~60,000 | 0 server errors; 358 pixels never confirmed; connects timing out at 60 s | Past the limit from 2,700 users. Servers too busy to answer Prometheus for ~1 min each (no crashes). k6 CPU not captured. |

| 4 | 2026-11-15 | 3 | 3,000 | ramp, 5 × 1 min | 1.4 s | 10.9 s | > 1 s (above top bucket) | 0.86 s | 0.99 | ~74,000 | 0 | Unplanned repeat of run 2 (meant to be 1 replica, but `compose run` restored 3; fixed with `--no-deps`). At 2,400 users: round trip p95 242 ms vs 231 ms in run 2, so results below the knee are repeatable. |
| 5 | 2026-11-15 | 1 | 3,000 target, ~1,635 connected | ramp, 5 × 1 min | 11.5 s | 47.6 s | > 1 s (above top bucket) | 5.5 s | 1.11 | ~17,000 | 0 server errors; 248 pixels never confirmed; connects timing out at 60 s | Fine at 600 users, strained at 1,200 (CPU 0.84, lag 370 ms), collapsed from 1,800. Server too busy to answer Prometheus near the end. |
| 6 | 2026-11-16 | 3 | 1,500 | ramp, 5 × 1 min | 111 ms | 27 ms | 10 ms | 79 ms | 0.35 | ~12,000 | 0 | After batching. Round trip median 63 ms vs 16 ms before: the 100 ms batch wait costs latency at low load. |
| 7 | 2026-11-16 | 3 | 3,000 | ramp, 5 × 1 min | 124 ms | 53 ms | 12 ms | 88 ms | 0.60 | ~29,000 | 0 | After batching. No knee: all 3,005 connected, CPU 0.60 at peak (was 1.02 and collapsing). |
| 8 | 2026-11-16 | 3 | 4,500 | ramp, 5 × 1 min | 184 ms | 139 ms | 160 ms | 126 ms | 0.80 | ~44,000 | 0 | After batching. All 4,506 connected (was ~2,870). Latency starting to rise in the last step, so near but not past the knee. |
| 9 | 2026-11-16 | 1 | 3,000 | ramp, 5 × 1 min | 379 ms | 65 ms | 50 ms | 257 ms | 0.80 | ~9,600 | 0 | After batching. All 3,000 connected (was ~1,635, collapsing from 1,800). Strained but stable. |

## Observations

- **Capacity knee (3 replicas, this laptop):** between ~2,400 and ~3,000 simulated users (~800–1,000 connections per server). Below it, latency grows gradually; past it, it jumps by 10–100×.
- **Fan-out grows with the square of the user count:** each doubling of users roughly quadrupled messages delivered per second (600 → 1,200 users: 3,600 → 14,300/s; 1,200 → 2,400: 14,300 → 58,400/s), because placements and recipients both grow with users.
- **Throughput ceiling:** ~70,000 messages/s delivered across 3 servers, reached when every server's CPU was at ~1.0 (one full core, Node's single-thread limit).
- **Event loop lag reached ~100 ms at only ~0.5 CPU** (1,500 users), so work arrives in blocking bursts even well before saturation.
- **No crashes and no server-side errors** even far past the limit: the system degraded by getting slow rather than failing.
- **1 vs 3 replicas:** the knee moved from ~1,200 users (1 replica) to ~2,400–2,700 (3 replicas). Message throughput scaled ~4× (~17,000 → ~70,000/s), but user capacity only ~2×, because fan-out work grows with users². Tripling servers buys about √3 ≈ 1.7× more users when every user receives every pixel.
- **Same load, 1,200 users:** 1 replica had round trip p95 299 ms and lag 370 ms; 3 replicas had 59 ms and 69 ms.

### Bottleneck and fix (milestone 6)

- **Profile** (1 replica, ramp to 1,200 simulated users, `node --cpu-prof`): the server was busy 48.6% of the time, and 43.6% of all samples were inside `broadcast()`, almost entirely the `writev` system call (one per socket per pixel). `JSON.stringify`, snapshots, and connection handling were each under 1%. Each pixel blocked the event loop for ~54 ms (~900 sockets × ~60 µs).
- **Fix:** batch pixels on each server and send one `pixels` message per socket every 100 ms, so sends per second depend on the number of sockets, not pixels × sockets.

| Same test | Before | After | Change |
|---|---|---|---|
| 3 replicas, 3,000 users: round trip p95 | 2.4 s | 124 ms | ~19× faster |
| 3 replicas, 3,000 users: snapshot p95 | 12.4 s | 53 ms | ~230× faster |
| 3 replicas, 3,000 users: max event loop lag | 1.14 s | 88 ms | ~13× lower |
| 3 replicas, 3,000 users: busiest CPU | 1.02 | 0.60 | no longer saturated |
| 3 replicas, 4,500 target: connected | ~2,870 | 4,506 (all) | |
| 3 replicas, 4,500 users: round trip p95 | 16.4 s | 184 ms | |
| 1 replica, 3,000 target: connected | ~1,635 | 3,000 (all) | |
| 1 replica, 3,000 users: round trip p95 | 11.5 s | 379 ms | |
| 3 replicas, 1,500 users: round trip p95 | 82 ms | 111 ms | **worse**: batching adds up to 100 ms when the system isn't loaded |

- **Trade-off:** batching raises latency at low load (median round trip 16 ms → 63 ms at 1,500 users) in exchange for staying stable at much higher load.
- **New ceiling not yet found** for 3 replicas: at 4,500 users latency had started rising (p95 134 ms → 179 ms in the last step), so the knee is likely somewhat above 4,500 on this laptop.
