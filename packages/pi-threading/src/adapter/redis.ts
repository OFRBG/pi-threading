// The Redis binding: a network-shared alternative to the Appendix B local-fs
// binding (`./local-fs.ts`) so a fleet of `pi` agent processes can coordinate
// across hosts/OSes instead of over a shared filesystem. This file must
// replicate local-fs's *observable* behavior (durability, deliver-once, FIFO,
// live wake, presence, journal) — not its on-disk layout. Comments below
// point back at the local-fs binding and the spec sections it mirrors.
//
// Client choice: `ioredis` over `node-redis`. Reasons: (1) first-class,
// synchronous-feeling Lua scripting via `defineCommand` (used below for the
// atomic claim-on-receive), (2) a mature, actively maintained in-memory mock
// (`ioredis-mock`) that implements EVAL (via the `fengari` Lua VM), pub/sub,
// sorted sets and TTL well enough to unit-test this adapter with zero network
// access, and (3) `duplicate()` for a clean dedicated pub/sub connection,
// which mirrors exactly what real Redis requires (a subscribed connection
// cannot issue other commands).
import type { Redis as RedisClient } from "ioredis";
import type { StateFile, Mail, ThreadSummary } from "../core/types";
import { PROCESSED_TTL_MS, toSummary } from "../core/types";
import type { StorageAdapter, JournalAdapter, PiFlagParam, AdapterOptions } from "./types";
import { requireDep, safeMailKey } from "./shared";

export const options = {
  "connection-string": {
    type: "string",
    description:
      "(Storage: redis) Connection string for Redis storage. Default: redis://localhost:6379.",
    default: "redis://localhost:6379",
  },
} satisfies Record<string, PiFlagParam>;

// Key layout — one logical "row" per concept, namespaced under `thread:`:
//
//   thread:index                        Set<threadId>            — every thread ever seen (listThreads)
//   thread:<id>:state                   String (JSON StateFile)  — presence (loadState/saveState)
//   thread:<id>:journal                 String (append-only)     — journal.md equivalent
//   thread:<id>:inbox:hash              Hash<tail, Mail JSON>     — envelope storage, keyed by ULID tail
//   thread:<id>:inbox:idx               ZSet<tail, score=0>       — FIFO index; ZRANGEBYLEX sorts tails
//                                                                    lexically, which — because ULIDs are
//                                                                    fixed-width, time-sortable strings
//                                                                    (`src/core/ids.ts`) — is exactly send
//                                                                    order, mirroring local-fs's sorted
//                                                                    `readdir` (Appendix B).
//   thread:<id>:processed:<tail>        String (JSON, w/ PX TTL) — audit trail of claimed mail; Redis's
//                                                                    native key expiry replaces local-fs's
//                                                                    hand-rolled once-per-hour GC pass
//                                                                    (`pruneProcessed` in local-fs.ts) —
//                                                                    same observable effect (processed mail
//                                                                    disappears after PROCESSED_TTL_MS),
//                                                                    simpler mechanism.
//   thread:<id>:mail                    Pub/Sub channel           — watchMail wake signal only; the
//                                                                    hash/zset above are the durable
//                                                                    source of truth, exactly as fs.watch
//                                                                    is only a signal over local-fs's
//                                                                    durable inbox/ directory (§ THREAD-MODEL
//                                                                    "Live push").
function keyIndex(): string {
  return "thread:index";
}
function keyState(id: string): string {
  return `thread:${id}:state`;
}
function keyJournal(id: string): string {
  return `thread:${id}:journal`;
}
function keyInboxHash(id: string): string {
  return `thread:${id}:inbox:hash`;
}
// Parallel hash: tail -> `<deliverAfter>\t<expiresAt>` (either half may be
// empty). Kept separate from the JSON payload hash above so the claim
// script (below) never has to parse JSON — Redis's Lua runtime (via
// `ioredis-mock`'s `fengari` VM, and vanilla Redis's own Lua 5.1) has no
// `cjson` decoder available by default, so date-gating logic reads these
// two plain strings instead of decoding the envelope.
function keyInboxMeta(id: string): string {
  return `thread:${id}:inbox:meta`;
}
function keyInboxIdx(id: string): string {
  return `thread:${id}:inbox:idx`;
}
function keyProcessedPrefix(id: string): string {
  return `thread:${id}:processed:`;
}
function channelMail(id: string): string {
  return `thread:${id}:mail`;
}

// Atomically enqueues one envelope: HSET the payload + HSET the date-gating
// metadata + ZADD the FIFO index (idempotent — re-adding an existing member
// is a no-op) in a single script, so a concurrent receiveMail (below) never
// observes any one of the three updated without the others.
const SEND_MAIL_SCRIPT = `
local hashKey = KEYS[1]
local idxKey = KEYS[2]
local metaKey = KEYS[3]
local tail = ARGV[1]
local json = ARGV[2]
local deliverAfter = ARGV[3]
local expiresAt = ARGV[4]
redis.call('HSET', hashKey, tail, json)
redis.call('HSET', metaKey, tail, deliverAfter .. '\\t' .. expiresAt)
redis.call('ZADD', idxKey, 0, tail)
return 1
`;

// Atomically claims every currently-due envelope: reads the FIFO index in
// lexical (= chronological, since tails are fixed-width time-sortable ULIDs)
// order, and for each tail either leaves it in place (not due yet — §6
// deliverAfter, mirrors local-fs's "stays queued" comment) or claims it
// (removes from hash+meta+idx, records a TTL'd processed key for audit, and
// — unless it's past its Rev 10 §6 expiresAt — appends it to the returned
// claimed list). Running this as one Lua script is what makes "claim it"
// atomic across concurrent readers: Redis executes scripts single-threaded,
// so two `receiveMail` calls racing on the same thread can never both claim
// the same envelope (deliver-once), and a reader can never observe a
// partially-claimed batch.
//
// Date comparisons are done as plain Lua string comparisons against the
// `deliverAfter`/`expiresAt` halves of the metadata hash, never by decoding
// the envelope's JSON — ISO 8601 UTC timestamps (`toISOString()`) are
// fixed-width and zero-padded, so lexicographic string order *is*
// chronological order, and neither vanilla Redis's Lua 5.1 nor
// `ioredis-mock`'s `fengari` VM ship a `cjson` decoder by default.
//
// The claimed batch is returned as one newline-joined string, not a Lua
// table built up with `table.insert`/index assignment: `ioredis-mock`'s
// `fengari`-backed VM (as of the version pinned in package-lock.json) has a
// table→JS conversion bug where a table *grown incrementally* to 2+ entries
// silently converts to `undefined` on return, even though a table *literal*
// of the same size round-trips fine (reproduced independently of this
// adapter — see the Notes section of the implementation report). A claimed
// envelope's JSON never contains a raw (unescaped) newline — `JSON.stringify`
// always escapes one to the two characters `\n` — so `\n` is a safe,
// unambiguous separator; the JS side splits on it and ignores the trailing
// empty segment.
const RECEIVE_MAIL_SCRIPT = `
local hashKey = KEYS[1]
local idxKey = KEYS[2]
local metaKey = KEYS[3]
local now = ARGV[1]
local ttlMs = ARGV[2]
local processedPrefix = ARGV[3]
local tails = redis.call('ZRANGEBYLEX', idxKey, '-', '+')
local claimed = ''
for i = 1, #tails do
  local tail = tails[i]
  local meta = redis.call('HGET', metaKey, tail)
  local deliverAfter = ''
  local expiresAt = ''
  if meta then
    local tabIdx = string.find(meta, '\\t', 1, true)
    if tabIdx then
      deliverAfter = string.sub(meta, 1, tabIdx - 1)
      expiresAt = string.sub(meta, tabIdx + 1)
    end
  end
  local due = true
  if deliverAfter ~= '' and deliverAfter > now then
    due = false
  end
  if due then
    local json = redis.call('HGET', hashKey, tail)
    redis.call('ZREM', idxKey, tail)
    redis.call('HDEL', hashKey, tail)
    redis.call('HDEL', metaKey, tail)
    if json then
      redis.call('SET', processedPrefix .. tail, json, 'PX', ttlMs)
      local expired = expiresAt ~= '' and expiresAt <= now
      if not expired then
        claimed = claimed .. json .. '\\n'
      end
    end
  end
end
return claimed
`;

interface ReceiveMailCommand {
  (
    hashKey: string,
    idxKey: string,
    metaKey: string,
    now: string,
    ttlMs: number,
    processedPrefix: string,
  ): Promise<string>;
}
interface SendMailCommand {
  (
    hashKey: string,
    idxKey: string,
    metaKey: string,
    tail: string,
    json: string,
    deliverAfter: string,
    expiresAt: string,
  ): Promise<number>;
}

type ScriptedRedis = RedisClient & {
  receiveMailClaim: ReceiveMailCommand;
  sendMailEnqueue: SendMailCommand;
};

/** Builds the adapter against an already-constructed client — the seam unit
 *  tests use to inject `ioredis-mock` instead of a live server (no network,
 *  no `--thread-storage redis` flag needed to exercise the logic below).
 *  `createAdapter()` is the production entry point that wires up a real
 *  `ioredis` client and delegates here. */
export function createAdapterFromClient(client: RedisClient): StorageAdapter & JournalAdapter {
  const scripted = client as ScriptedRedis;
  scripted.defineCommand("sendMailEnqueue", { numberOfKeys: 3, lua: SEND_MAIL_SCRIPT });
  scripted.defineCommand("receiveMailClaim", { numberOfKeys: 3, lua: RECEIVE_MAIL_SCRIPT });

  // A dedicated connection for pub/sub: a Redis connection in subscribe mode
  // cannot issue ordinary commands, so wake signals need their own client —
  // `duplicate()` shares the same connection options (and, in ioredis-mock,
  // the same in-memory store) as `client`.
  const subscriber = client.duplicate();
  // channel -> the set of local callbacks currently watching it. Multiple
  // `watchMail` calls for the same thread (or from different modules)
  // share one underlying SUBSCRIBE.
  const watchers = new Map<string, Set<() => void>>();
  let subscriberReady = false;

  function ensureSubscriberListening() {
    if (subscriberReady) {
      return;
    }
    subscriberReady = true;
    subscriber.on("message", (channel: string) => {
      const cbs = watchers.get(channel);
      if (!cbs) {
        return;
      }
      for (const cb of cbs) {
        cb();
      }
    });
  }

  return {
    async configure() {
      // Fail-soft connectivity probe: logs but never throws, so a
      // momentarily-unreachable Redis doesn't crash extension startup —
      // ioredis's own offline command queue (default `enableOfflineQueue:
      // true`) will retry once the connection comes up.
      try {
        await client.ping();
      } catch (err) {
        console.error("[thread] redis: initial connectivity check failed:", err);
      }
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const raw = await client.get(keyState(threadId));
      if (raw === null) {
        return undefined;
      }
      try {
        return JSON.parse(raw) as StateFile;
      } catch (err) {
        console.error("[thread] failed to read state:", err);
        return undefined;
      }
    },

    async saveState(threadId: string, state: StateFile) {
      // Redis's SET on a single key is atomic — presence readers (§8.1)
      // never observe a torn/partial value, the same guarantee local-fs
      // gets from write-temp+rename.
      await client
        .multi()
        .set(keyState(threadId), JSON.stringify(state))
        .sadd(keyIndex(), threadId)
        .exec();
    },

    async appendJournal(threadId: string, entry: string) {
      await client.append(keyJournal(threadId), entry);
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const raw = await client.get(keyJournal(threadId));
      if (raw === null) {
        return undefined;
      }
      const content = raw.trim();
      return content || undefined;
    },

    async listThreads(): Promise<ThreadSummary[]> {
      const ids = await client.smembers(keyIndex());
      const out: ThreadSummary[] = [];
      for (const id of ids) {
        const raw = await client.get(keyState(id));
        if (raw === null) {
          continue;
        }
        try {
          const s: StateFile = JSON.parse(raw);
          out.push(toSummary(s));
        } catch {
          // corrupt/partial — skip, matching local-fs's behavior.
        }
      }
      return out;
    },

    async threadExists(threadId: string): Promise<boolean> {
      return (await client.exists(keyState(threadId))) === 1;
    },

    async sendMail(mail: Mail) {
      // Hash field = the id's ULID tail (`safeMailKey`): a retried send with
      // the same id lands on the same field — enqueue idempotence (§7.6),
      // exactly as local-fs's same-filename overwrite.
      const tail = safeMailKey(mail.id);
      await scripted.sendMailEnqueue(
        keyInboxHash(mail.to),
        keyInboxIdx(mail.to),
        keyInboxMeta(mail.to),
        tail,
        JSON.stringify(mail),
        mail.deliverAfter ?? "",
        mail.expiresAt ?? "",
      );
      // Pub/sub is only the wake signal (§ THREAD-MODEL "Live push") —
      // durability already landed above. A publish with no subscribers is a
      // harmless no-op; the next poll-driven drain (heartbeat/turn_end)
      // picks the mail up regardless.
      await client.publish(channelMail(mail.to), "1");
    },

    async receiveMail(threadId: string): Promise<Mail[]> {
      const claimedBatch = await scripted.receiveMailClaim(
        keyInboxHash(threadId),
        keyInboxIdx(threadId),
        keyInboxMeta(threadId),
        new Date().toISOString(),
        PROCESSED_TTL_MS,
        keyProcessedPrefix(threadId),
      );
      // See RECEIVE_MAIL_SCRIPT's comment: the script returns claimed
      // envelopes newline-joined rather than as a Lua table, to route around
      // an ioredis-mock/fengari table→JS conversion bug.
      const claimedJson = claimedBatch.split("\n").filter(s => s.length > 0);
      const claimed: Mail[] = [];
      for (const j of claimedJson) {
        try {
          claimed.push(JSON.parse(j) as Mail);
        } catch (err) {
          // Should be unreachable in normal operation — every entry here was
          // written by this adapter's own `sendMail` via `JSON.stringify`.
          // Unlike local-fs (which can leave a malformed file in place and
          // retry it forever, since the filesystem is the only source of
          // truth), the claim above has already atomically removed this
          // entry from the index — there's nothing left to "leave in place".
          // Logged and dropped rather than thrown, so one corrupt entry
          // doesn't take the rest of the batch down with it.
          console.error("[thread] redis: dropping unparsable claimed mail:", err);
        }
      }
      return claimed;
    },

    watchMail(threadId: string, cb: () => void): () => void {
      ensureSubscriberListening();
      const channel = channelMail(threadId);
      let cbs = watchers.get(channel);
      if (!cbs) {
        cbs = new Set();
        watchers.set(channel, cbs);
        // Fire-and-forget: matches local-fs's `watchMail`, which is
        // synchronous and returns the disposer immediately, not a promise
        // the caller has to await. Errors are logged, never thrown.
        subscriber.subscribe(channel).catch((err: unknown) => {
          console.error("[thread] failed to subscribe to mail channel:", err);
        });
      }
      cbs.add(cb);
      return () => {
        const set = watchers.get(channel);
        if (!set) {
          return;
        }
        set.delete(cb);
        if (set.size === 0) {
          watchers.delete(channel);
          subscriber.unsubscribe(channel).catch(() => {});
        }
      };
    },
  };
}

/** Production entry point: builds a `StorageAdapter & JournalAdapter` that
 *  looks and behaves exactly like `createAdapterFromClient`'s object, but
 *  defers ever touching the real `ioredis` package until `configure()` runs
 *  (via `requireDep`, `./shared.ts` — see its docstring for why `require()`
 *  rather than a dynamic `import()`).
 *
 *  This has to stay a *synchronous* function returning a plain object, not
 *  `async` — `resolveAdapter()`/`store.adapter` are a synchronous,
 *  memoized-on-first-access pair (see registry.ts, state.ts), and `ioredis`
 *  is only actually needed when `--thread-storage redis` is selected. This
 *  module, though, is imported unconditionally by registry.ts (to read
 *  `options` for flag registration) regardless of which backend ends up
 *  selected — a top-level `import RedisCtor from "ioredis"` would make that
 *  import eager. Under Bun, eagerly loading `ioredis`'s large, cyclic
 *  dependency graph triggers "Maximum call stack size exceeded" in Bun's
 *  module resolver, even when the client is never constructed. Deferring
 *  the load to `configure()` — the one method every caller already awaits
 *  before touching anything else on this object — avoids that for callers
 *  who never select the redis backend. */
export function createAdapter({
  "connection-string": connectionString,
}: AdapterOptions<typeof options>): StorageAdapter & JournalAdapter {
  let inner: (StorageAdapter & JournalAdapter) | undefined;

  return {
    async configure() {
      const RedisCtor = requireDep<typeof RedisClient>("ioredis", import.meta.url);
      const client = new RedisCtor(connectionString, {
        // Defer the actual TCP connect until a command is issued (ioredis
        // connects lazily on first command when `lazyConnect: true`),
        // mirroring local-fs's `configure()` doing its own setup (mkdir)
        // rather than connecting eagerly at construction time.
        lazyConnect: true,
        // Never buffer commands forever waiting on a connection that will
        // never come — a fleet-mode misconfiguration should surface as
        // errors, not silent, endless queueing.
        maxRetriesPerRequest: 3,
      });
      inner = createAdapterFromClient(client);
      await inner.configure();
    },
    loadState: threadId => inner!.loadState(threadId),
    saveState: (threadId, state) => inner!.saveState(threadId, state),
    listThreads: () => inner!.listThreads(),
    threadExists: threadId => inner!.threadExists(threadId),
    sendMail: mail => inner!.sendMail(mail),
    receiveMail: threadId => inner!.receiveMail(threadId),
    watchMail: (threadId, cb) => inner!.watchMail(threadId, cb),
    appendJournal: (threadId, entry) => inner!.appendJournal(threadId, entry),
    readJournal: threadId => inner!.readJournal(threadId),
  };
}
