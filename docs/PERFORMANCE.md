# Performance

What was measured, how, and what the numbers do and do not tell you. Re-run these before launch on hardware that
resembles production; the figures below come from a single developer laptop.

## Method

- **Data:** `apps/api/scripts/perf-seed.sql` creates 5,000 users, about 25,000 friendships and 300,000 posts.
  `perf-cleanup.sql` removes it all again.
- **HTTP:** `apps/api/scripts/load-test.mjs` uses autocannon, 50 connections, 10 s per endpoint, authenticated as the
  seeded user with the most friends (50).
- **Sockets:** 40 concurrent senders each send 25 messages and wait for the acknowledgement; one receiver counts deliveries.
- **Setup:** one Node process (the API), Postgres/Redis in Docker Desktop, load generator on the same machine, so the
  generator competes with the server for CPU. Rate limits were raised for the run
  (`RATE_LIMIT_USER_PER_MIN=100000000`); leave them on in production.

```bash
docker exec -i social-postgres-1 psql -U social -d social < apps/api/scripts/perf-seed.sql
cd apps/api
RATE_LIMIT_USER_PER_MIN=100000000 RATE_LIMIT_IP_PER_MIN=100000000 node dist/main.js &
node scripts/load-test.mjs          # set DATABASE_URL and JWT_ACCESS_SECRET to match the API
docker exec -i social-postgres-1 psql -U social -d social < apps/api/scripts/perf-cleanup.sql
```

## Results (single laptop, one API process)

| Endpoint | req/s | p50 | p97.5 | p99 | errors |
|---|---|---|---|---|---|
| `GET /v1/health` | 1,315 | 35 ms | 63 ms | 73 ms | 0 |
| `GET /v1/users/me` | 874 | 54 ms | 83 ms | 91 ms | 0 |
| `GET /v1/feed?limit=20` | 590 | 79 ms | 128 ms | 134 ms | 0 |
| `GET /v1/conversations` | 830 | 56 ms | 90 ms | 96 ms | 0 |
| `GET /v1/notifications` | 855 | 56 ms | 80 ms | 89 ms | 0 |

| Socket `message:send` | value |
|---|---|
| Concurrent senders | 40 |
| Messages sent / failed | 1,000 / 0 |
| Throughput | about 505 msg/s |
| Ack latency p50 / p95 / p99 | 78 / 101 / 108 ms |
| Delivered to the receiver | 1,000 of 1,000 |

Latencies at 50 concurrent connections are dominated by queueing in a single Node process; they are not the cost of
one request. One request on an idle server is a few milliseconds.

## What the performance pass changed

The first feed query walked the global `posts` timeline newest first and discarded posts by strangers. It was fast on
300k rows (8 to 15 ms) but its cost grows with the whole table: for a viewer with 50 friends it removed 58,000 rows to
find 21. It was replaced with a per-author index probe (`posts_author_idx`) merged with a top-N sort, and the
visibility checks moved from once per post to once per author.

| Viewer | Before | After |
|---|---|---|
| 50 friends, 300k posts | 14.8 ms | 1.0 ms |
| 10 friends, 300k posts | 7.8 ms | 0.3 ms |

The new cost depends on how many friends a viewer has (about 21 index probes each), not on how many posts exist.
`FEED_SQL` is exported from `posts.service.ts` so the plan can be inspected with `EXPLAIN (ANALYZE, BUFFERS)`.

## Known limits and what to do about them

- **Very large friend lists.** A viewer with thousands of friends makes thousands of probes per page. Cap the
  considered authors, or move to fan-out-on-write (a Redis list per user) once real data shows it is needed.
- **Presence and room sizes** use Redis sorted sets and Socket.IO `fetchSockets()`. The latter is fine for live-stream
  viewer counts at hundreds of viewers; for thousands, count with a Redis counter instead.
- **Single API process.** Socket.IO uses the Redis adapter, so running several replicas behind a load balancer works,
  but this was not load tested with more than one instance.
- **Video transcoding** runs in the API process (BullMQ worker, concurrency 2). Move it to a separate worker deployment
  before accepting many video uploads, otherwise encodes compete with request handling.
- **Not measured:** media delivery through a CDN, LiveKit capacity (it has its own benchmarking tools), cold starts,
  and mobile rendering performance on real devices.
