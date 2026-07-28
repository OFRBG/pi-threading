// A thin HTTP client `StorageAdapter` + `JournalAdapter` — the "A. Thin HTTP
// client adapter" shape from docs/http-adapter-evaluation.md §1: every
// method is a `fetch()` call against a remote thread-store service. The
// reference server implementing that service lives in
// `src/adapter/http-server.ts` (run standalone via `bin/thread-http-server.mjs`,
// `npm run http-server`), but any server implementing the same endpoint
// surface (§2 of the eval doc) works — the client never knows what's behind
// it, same as this codebase's Mongo/Redis adapters would embed a driver
// without knowing how the remote store persists.
//
// This is a *first, minimal* version, deliberately: no auth (see the eval
// doc §4 and `http-server.ts`'s `checkAuth` seam — a bearer-token flag would
// slot in here later without changing this shape), no CAS/optimistic
// concurrency on `saveState` (each thread only ever writes its own state
// per THREAD-MODEL.md, so there is no concurrent writer to protect against
// yet), no dependency beyond Node's built-in `fetch`.
import type { StateFile, Mail, ThreadSummary } from "../core/types";
import type { StorageAdapter, JournalAdapter, PiFlagParam, AdapterOptions } from "./types";

// How long the server is asked to hold a `/inbox/wait` request open before
// replying 204 (no mail). The watch loop just re-issues another one
// immediately after either outcome — §3 of the eval doc.
const LONG_POLL_TIMEOUT_SEC = 25;
// Fallback cadence if the long-poll request itself fails (network blip,
// server restart) — the "interval poll as backstop" the eval doc
// recommends pairing with long-poll, rather than hot-looping against a
// downed server.
const WATCH_RETRY_MS = 2_000;

const enc = (id: string) => encodeURIComponent(id);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const options = {
  "base-url": {
    type: "string",
    description: "(Storage: http) Base URL of the thread-store service.",
    default: "http://localhost:7777",
  },
} satisfies Record<string, PiFlagParam>;

export function createAdapter({
  "base-url": baseUrl,
}: AdapterOptions<typeof options>): StorageAdapter & JournalAdapter {
  const url = baseUrl.replace(/\/+$/, "");

  return {
    async configure() {
      // No client-side bootstrap needed — the service owns its own state
      // (§2 of the eval doc: "configure(): none, or GET /health").
    },

    async loadState(threadId: string): Promise<StateFile | undefined> {
      const res = await fetch(`${url}/threads/${enc(threadId)}/state`);
      if (res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        throw new Error(`loadState ${threadId}: HTTP ${res.status}`);
      }
      return (await res.json()) as StateFile;
    },

    async saveState(threadId: string, state: StateFile) {
      const res = await fetch(`${url}/threads/${enc(threadId)}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) {
        throw new Error(`saveState ${threadId}: HTTP ${res.status}`);
      }
    },

    async listThreads(): Promise<ThreadSummary[]> {
      const res = await fetch(`${url}/threads`);
      if (!res.ok) {
        throw new Error(`listThreads: HTTP ${res.status}`);
      }
      return (await res.json()) as ThreadSummary[];
    },

    async threadExists(threadId: string): Promise<boolean> {
      const res = await fetch(`${url}/threads/${enc(threadId)}/state`, { method: "HEAD" });
      return res.ok;
    },

    async sendMail(mail: Mail) {
      // PUT keyed by the envelope's own id: idempotent by HTTP semantics —
      // a retry after a dropped ACK overwrites the same logical row rather
      // than double-enqueuing, mirroring how local-fs's filename-is-the-id
      // gives enqueue idempotence for free (§2.3 of the eval doc).
      const res = await fetch(`${url}/threads/${enc(mail.to)}/inbox/${enc(mail.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mail),
      });
      if (!res.ok) {
        throw new Error(`sendMail ${mail.id}: HTTP ${res.status}`);
      }
    },

    async receiveMail(threadId: string): Promise<Mail[]> {
      // Server-side atomic claim: due, unclaimed mail is selected and
      // marked claimed in one request — never double-delivered, FIFO by
      // ULID (§2.4 of the eval doc).
      const res = await fetch(`${url}/threads/${enc(threadId)}/inbox/claim`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`receiveMail ${threadId}: HTTP ${res.status}`);
      }
      const { claimed } = (await res.json()) as { claimed: Mail[] };
      return claimed;
    },

    watchMail(threadId: string, cb: () => void): () => void {
      let stopped = false;
      let controller: AbortController | null = null;

      void (async function loop() {
        while (!stopped) {
          controller = new AbortController();
          try {
            const res = await fetch(
              `${url}/threads/${enc(threadId)}/inbox/wait?timeout=${LONG_POLL_TIMEOUT_SEC}`,
              { signal: controller.signal },
            );
            if (stopped) {
              return;
            }
            // 200: mail landed — this is only a wake signal (§3): the real
            // payload only ever comes from the caller's subsequent
            // receiveMail, exactly like local-fs's fs.watch callback.
            if (res.status === 200) {
              cb();
            }
            // 204 / timeout: no mail — loop immediately, re-issue.
          } catch (err) {
            if (stopped) {
              return;
            }
            // Aborted by our own unsubscribe below — expected, not a real
            // failure, so don't apply the network-blip backoff for it.
            if ((err as { name?: string }).name === "AbortError") {
              continue;
            }
            await sleep(WATCH_RETRY_MS);
          }
        }
      })();

      return () => {
        stopped = true;
        controller?.abort();
      };
    },

    async appendJournal(threadId: string, entry: string) {
      const res = await fetch(`${url}/threads/${enc(threadId)}/journal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      if (!res.ok) {
        throw new Error(`appendJournal ${threadId}: HTTP ${res.status}`);
      }
    },

    async readJournal(threadId: string): Promise<string | undefined> {
      const res = await fetch(`${url}/threads/${enc(threadId)}/journal`);
      if (res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        throw new Error(`readJournal ${threadId}: HTTP ${res.status}`);
      }
      const { content } = (await res.json()) as { content: string };
      return content || undefined;
    },
  };
}
