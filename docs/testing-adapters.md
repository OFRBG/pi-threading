# Testing the storage adapters

Every backend implements the same `StorageAdapter` (+ optional `JournalAdapter`)
contract from `src/adapter/types.ts`, and every one is tested **offline** — no
externally-running server is required for `npm run test:unit` to pass. This doc
covers running those tests and, separately, exercising each backend against a
real server.

## At a glance

| Backend  | `--thread-storage` | Tests live in                | Offline test mechanism                              |
| -------- | ------------------ | ---------------------------- | --------------------------------------------------- |
| local-fs | `local` (default)  | `test/unit.test.ts`          | real `fs` in a temp `base-dir`                      |
| redis    | `redis`            | `test/unit.test.ts`          | `ioredis-mock` (in-memory), injected via a seam     |
| mongo    | `mongo`            | `test/mongo-adapter.test.ts` | `mongodb-memory-server` (spawns a local `mongod`)   |
| http     | `http`             | `test/unit.test.ts`          | reference server started in-process, ephemeral port |

## Run the tests

```bash
# Everything (both test files — this is what CI runs)
npm run test:unit

# One backend only (exact describe-name prefixes)
node --import tsx --test --test-name-pattern="adapter: LocalFsAdapter" test/unit.test.ts
node --import tsx --test --test-name-pattern="adapter: RedisAdapter"   test/unit.test.ts
node --import tsx --test --test-name-pattern="adapter: http"           test/unit.test.ts
node --import tsx --test test/mongo-adapter.test.ts   # the "adapter: MongoAdapter" suite
```

Every backend is covered for the same invariants: state round-trip, `listThreads`
/ `threadExists`, **durable queue** (mail sent before the target ever starts),
**deliver-once**, **FIFO by ULID tail**, `deliverAfter` hold, `expiresAt` discard,
`watchMail` live delivery, and journal round-trip.

### Notes per backend

- **local-fs** — pure `fs`; nothing to install, nothing to clean up (each test uses
  its own temp dir).
- **redis** — uses `ioredis-mock`, injected through the `createAdapterFromClient()`
  seam, so the real Lua claim scripts run with zero network. No `REDIS_URL` needed.
- **mongo** — `mongodb-memory-server` downloads a `mongod` binary on **first run**
  (needs network once; cached afterwards). It's a _standalone_ server, so the tests
  exercise the **polling** `watchMail` path — the change-stream path only runs
  against a replica set (see below).
- **http** — the reference server (`src/adapter/http-server.ts`) is started with
  `startServer(0)` on an ephemeral port per test and torn down after; the client
  talks to it over real HTTP.

## Exercise a backend against a real server

Offline tests prove the logic; these prove wiring, auth reach, and networked
`watchMail`. Point `pi` at the backend with `--thread-storage <name>` plus its
connection flag.

### redis

```bash
docker run --rm -p 6379:6379 redis
pi --extension ./src/index.ts --thread-id t1 \
   --thread-storage redis \
   --thread-storage-connection-string redis://localhost:6379
```

### mongo

```bash
# Standalone (uses the polling watchMail path)
docker run --rm -p 27017:27017 mongo
pi --extension ./src/index.ts --thread-id t1 \
   --thread-storage mongo \
   --thread-storage-connection-string mongodb://localhost:27017 \
   --thread-storage-database pi-threading
```

To exercise the **change-stream** `watchMail` path, run a replica set instead of a
standalone (`docker run … mongo --replSet rs0`, then `rs.initiate()` once). Against
a standalone, `watchMail` falls back to a 1s poll by design.

### http

```bash
npm run http-server            # reference server on :7777 (in-memory, no auth)
pi --extension ./src/index.ts --thread-id t1 \
   --thread-storage http \
   --thread-storage-base-url http://localhost:7777
```

Quick manual smoke test of the endpoint surface:

```bash
curl -s localhost:7777/health
curl -s -X PUT localhost:7777/threads/t1/state -d '{"id":"t1"}'
curl -s localhost:7777/threads
curl -s -X PUT localhost:7777/threads/t1/inbox/a%2F01 -d '{"id":"a/01","to":"t1","from":"a","body":"hi"}'
curl -s -X POST localhost:7777/threads/t1/inbox/claim   # → {"claimed":[…]}
```

> The reference server is in-memory and **has no auth** — for local/dev use only.
> A real deployment swaps the `Store` internals and fills in the `checkAuth` seam
> (`src/adapter/http-server.ts`). See `docs/http-adapter-evaluation.md`.

## Full quality gate

What CI checks, in order:

```bash
npx tsc --noEmit        # types (strict)
npm run lint            # oxlint
npm run format:check    # prettier
npm run test:unit       # all adapters, offline
```
