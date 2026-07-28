// A minimal, dependency-free reference server for the `http` StorageAdapter
// (`src/adapter/http.ts`), implementing the endpoint mapping settled on in
// docs/http-adapter-evaluation.md §2. Backed by plain in-memory Maps —
// because Node is single-threaded, every handler below runs to completion
// before the next request is dispatched, so "atomic claim" and the
// long-poll waiter registry are just ordinary synchronous data-structure
// operations, not something that needs a lock or a transaction.
//
// This is intentionally a *reference* implementation, not a production
// service: no persistence (a restart loses everything — durability here
// depends entirely on whatever real store a production deployment would put
// behind this same HTTP surface, per the eval doc §4), no auth (see
// `checkAuth` below), no horizontal scaling story. It exists so the `http`
// adapter can be exercised in-process by the unit test without any
// externally-running server, and as a template for a real deployment.
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StateFile, Mail, ThreadSummary } from "../core/types";
import { toSummary } from "../core/types";
import { isMailDue, isMailExpired, mailIdTail } from "./shared";

// ---- in-memory store ---------------------------------------------------

interface Store {
  states: Map<string, StateFile>;
  // Unclaimed mail per thread, keyed by mail id — a Map (not an array) so a
  // retried `PUT /inbox/:mailId` with the same id upserts the same logical
  // row instead of double-enqueuing (§2.3 of the eval doc).
  pending: Map<string, Map<string, Mail>>;
  // Ids already claimed (or claimed-but-expired-and-discarded) per thread.
  // A `PUT` that lands *after* its id was claimed must be a no-op — mirrors
  // local-fs, where nothing resurrects a message once it's in `processed/`.
  claimed: Map<string, Set<string>>;
  journals: Map<string, string>;
  // Pending long-poll waiters per thread; resolved (true) the instant new
  // mail lands for that thread, or (false) on the waiter's own timeout.
  waiters: Map<string, Array<(hasMail: boolean) => void>>;
}

function createStore(): Store {
  return {
    states: new Map(),
    pending: new Map(),
    claimed: new Map(),
    journals: new Map(),
    waiters: new Map(),
  };
}

function pendingFor(store: Store, threadId: string): Map<string, Mail> {
  let m = store.pending.get(threadId);
  if (!m) {
    m = new Map();
    store.pending.set(threadId, m);
  }
  return m;
}

function claimedFor(store: Store, threadId: string): Set<string> {
  let s = store.claimed.get(threadId);
  if (!s) {
    s = new Set();
    store.claimed.set(threadId, s);
  }
  return s;
}

/** Due (deliverAfter passed or absent), unclaimed mail for a thread, sorted
 *  FIFO by ULID tail — the server-side equivalent of local-fs's sorted
 *  `readdir` (§2.4 of the eval doc). Sorting by the tail (not the full
 *  `<from>/<ulid>` id) is what preserves send-time order across senders. */
function dueMailSorted(store: Store, threadId: string): Mail[] {
  const now = Date.now();
  const all = Array.from(pendingFor(store, threadId).values());
  return all
    .filter(m => isMailDue(m, now))
    .sort((a, b) => {
      const ta = mailIdTail(a.id);
      const tb = mailIdTail(b.id);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
}

/** Resolve every waiter registered for a thread — called once new mail is
 *  durably enqueued. This is *only* a wake signal (§3 of the eval doc): the
 *  waiter's caller must still call `/inbox/claim` to actually get the mail,
 *  exactly like local-fs's `fs.watch` callback triggers a drain and nothing
 *  more. */
function wake(store: Store, threadId: string) {
  const list = store.waiters.get(threadId);
  if (!list || list.length === 0) {
    return;
  }
  store.waiters.delete(threadId);
  for (const resolve of list) {
    resolve(true);
  }
}

// ---- auth seam ----------------------------------------------------------
//
// This is the first, no-auth version of the adapter (see
// docs/http-adapter-evaluation.md §4, "Auth — the one genuinely new risk
// class"). A deployment that exposes this server beyond a fully-trusted
// network MUST NOT do so as-is. This function is the seam where that work
// slots in later (a bearer-token check, mTLS, whatever the deployment
// needs) — deliberately a no-op here, since building auth is explicitly out
// of scope for this first version.
function checkAuth(_req: IncomingMessage): boolean {
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function notFound(res: ServerResponse) {
  res.writeHead(404);
  res.end();
}

/** The request handler, exported separately from `startServer` so a test
 *  (or a future alternate transport) can build a listener without binding a
 *  real socket. `threadId`/mail-id path segments are expected pre-encoded
 *  with `encodeURIComponent` (they can contain `/`, e.g. `<from>/<ulid>`
 *  mail ids) — see §2 of the eval doc's "concrete implementation gotcha". */
export function createRequestListener(
  store: Store = createStore(),
): (req: IncomingMessage, res: ServerResponse) => void {
  return function listener(req: IncomingMessage, res: ServerResponse) {
    void (async () => {
      if (!checkAuth(req)) {
        res.writeHead(401);
        res.end();
        return;
      }
      try {
        const parsedUrl = new URL(req.url ?? "/", "http://localhost");
        const parts = parsedUrl.pathname
          .split("/")
          .filter(Boolean)
          .map(part => decodeURIComponent(part));
        const method = req.method ?? "GET";

        // GET /health
        if (method === "GET" && parts.length === 1 && parts[0] === "health") {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GET /threads
        if (method === "GET" && parts.length === 1 && parts[0] === "threads") {
          const summaries: ThreadSummary[] = Array.from(store.states.values()).map(toSummary);
          sendJson(res, 200, summaries);
          return;
        }

        // GET|HEAD|PUT /threads/:id/state
        if (parts.length === 3 && parts[0] === "threads" && parts[2] === "state") {
          const id = parts[1];
          if (method === "GET") {
            const state = store.states.get(id);
            if (!state) {
              notFound(res);
              return;
            }
            sendJson(res, 200, state);
            return;
          }
          if (method === "HEAD") {
            res.writeHead(store.states.has(id) ? 200 : 404);
            res.end();
            return;
          }
          if (method === "PUT") {
            const body = await readBody(req);
            const state = JSON.parse(body) as StateFile;
            // Each thread only ever writes its own state (THREAD-MODEL.md) —
            // there is no concurrent writer to a single key, so a plain
            // upsert is all the "never torn" guarantee needs here (unlike
            // local-fs's write-temp+rename, an in-memory Map.set is already
            // atomic w.r.t. any other request, since Node runs this handler
            // to completion before the next one starts).
            store.states.set(id, state);
            res.writeHead(204);
            res.end();
            return;
          }
        }

        // PUT /threads/:to/inbox/:mailId
        if (
          method === "PUT" &&
          parts.length === 4 &&
          parts[0] === "threads" &&
          parts[2] === "inbox"
        ) {
          const to = parts[1];
          const mailId = parts[3];
          const body = await readBody(req);
          const mail = JSON.parse(body) as Mail;
          const claimedSet = claimedFor(store, to);
          // §2.3: a retry that lands after this id was already claimed is a
          // no-op — nothing resurrects mail once it's left the unclaimed set.
          if (!claimedSet.has(mailId)) {
            pendingFor(store, to).set(mailId, mail);
            wake(store, to);
          }
          res.writeHead(201);
          res.end();
          return;
        }

        // POST /threads/:id/inbox/claim
        if (
          method === "POST" &&
          parts.length === 4 &&
          parts[0] === "threads" &&
          parts[2] === "inbox" &&
          parts[3] === "claim"
        ) {
          const id = parts[1];
          const now = Date.now();
          const pending = pendingFor(store, id);
          const claimedSet = claimedFor(store, id);
          const claimed: Mail[] = [];
          // Snapshot + sort first, then mutate — the claim-then-return
          // ordering below is what makes "claimed but never seen by the
          // caller" this protocol's one declared loss window (§2.4 of the
          // eval doc, spec §7.7 Erratum 5), same as local-fs.
          for (const mail of dueMailSorted(store, id)) {
            pending.delete(mail.id);
            claimedSet.add(mail.id);
            // Expired-but-unclaimed: claimed into the audit set, never
            // returned or redelivered (Rev 10 §6, mirrors local-fs's
            // processed/ discard).
            if (isMailExpired(mail, now)) {
              continue;
            }
            claimed.push(mail);
          }
          sendJson(res, 200, { claimed });
          return;
        }

        // GET /threads/:id/inbox/wait?timeout=N (long-poll — §3 of the eval doc)
        if (
          method === "GET" &&
          parts.length === 4 &&
          parts[0] === "threads" &&
          parts[2] === "inbox" &&
          parts[3] === "wait"
        ) {
          const id = parts[1];
          const requested = Number(parsedUrl.searchParams.get("timeout"));
          const timeoutSec = Math.max(
            1,
            Math.min(60, Number.isFinite(requested) && requested > 0 ? requested : 30),
          );

          // Mail is already due and unclaimed: no need to hold the request
          // open at all. This is strictly better than local-fs's fs.watch,
          // which only fires on *new* filesystem events — but it's still
          // only a wake signal; the actual payload only ever comes back via
          // a subsequent /inbox/claim call.
          if (dueMailSorted(store, id).length > 0) {
            res.writeHead(200);
            res.end();
            return;
          }

          let settled = false;
          const finish = (hasMail: boolean) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            const list = store.waiters.get(id);
            if (list) {
              const i = list.indexOf(finish);
              if (i >= 0) {
                list.splice(i, 1);
              }
              if (list.length === 0) {
                store.waiters.delete(id);
              }
            }
            res.writeHead(hasMail ? 200 : 204);
            res.end();
          };
          const timer = setTimeout(() => finish(false), timeoutSec * 1000);
          const list = store.waiters.get(id) ?? [];
          list.push(finish);
          store.waiters.set(id, list);
          // A client-aborted long-poll (unsubscribe, process exit) must not
          // leak a waiter entry forever.
          req.on("close", () => finish(false));
          return;
        }

        // GET|POST /threads/:id/journal
        if (parts.length === 3 && parts[0] === "threads" && parts[2] === "journal") {
          const id = parts[1];
          if (method === "GET") {
            const content = store.journals.get(id);
            if (content === undefined || content.trim() === "") {
              notFound(res);
              return;
            }
            sendJson(res, 200, { content });
            return;
          }
          if (method === "POST") {
            const body = await readBody(req);
            const { entry } = JSON.parse(body) as { entry: string };
            store.journals.set(id, (store.journals.get(id) ?? "") + entry);
            res.writeHead(204);
            res.end();
            return;
          }
        }

        notFound(res);
      } catch (err) {
        console.error("[thread] http-server: request failed:", err);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      }
    })();
  };
}

/** Start listening. `port: 0` picks an ephemeral port — used by the unit
 *  test so it never depends on a fixed, possibly-in-use port. Returns the
 *  bound server plus the base URL to hand to `http` adapter's `base-url`
 *  option. */
export function startServer(port = 7777): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestListener());
    server.once("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}
