import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { spawn } from "node:child_process";
import type { StateFile, Envelope } from "../core/types";
import { STALE_MS } from "../core/types";
import { buildWakeLaunch } from "./wake-launch";

/**
 * Tracks known thread ids. Restate's per-key durable state has no "list all
 * keys of this object type" API, so a thread registering itself here is what
 * makes listThreads()/resolveTargets("*"|"role:x") possible against this
 * backend — the local-fs backend gets this for free from a directory listing.
 */
export const ThreadRegistry = restate.object({
  name: "ThreadRegistry",
  handlers: {
    register: async (ctx: ObjectContext, id: string) => {
      const ids = (await ctx.get<string[]>("ids")) ?? [];
      if (!ids.includes(id)) {
        ids.push(id);
        ctx.set("ids", ids);
      }
    },
    list: restate.handlers.object.shared(async (ctx: ObjectSharedContext) => {
      return (await ctx.get<string[]>("ids")) ?? [];
    }),
  },
});

/**
 * One durable instance per thread id, holding that thread's state/journal/
 * inbox in Restate's per-key state instead of files on disk. This is the
 * Restate binding of the Rev-8 store contract: the mailbox holds envelopes,
 * `deliverAfter` envelopes stay queued until due (drain filters them), and a
 * durable delayed self-invocation revives a stopped thread when one comes
 * due — the one thing the local-fs backend can never do.
 */
export const ThreadObject = restate.object({
  name: "Thread",
  handlers: {
    loadState: restate.handlers.object.shared(async (ctx: ObjectSharedContext) => {
      return (await ctx.get<StateFile>("state")) ?? null;
    }),

    saveState: async (ctx: ObjectContext, state: StateFile) => {
      ctx.set("state", state);
      // First-time registration is awaited: a fire-and-forget send here races
      // listThreads — a thread wouldn't be reliably listable (broadcastable)
      // the moment its own saveState returns. The flag keeps every later
      // save (one per heartbeat) from paying the registry round-trip.
      if (!(await ctx.get<boolean>("registered"))) {
        await ctx.objectClient(ThreadRegistry, "all").register(state.id);
        ctx.set("registered", true);
      }
    },

    appendJournal: async (ctx: ObjectContext, entry: string) => {
      const existing = (await ctx.get<string>("journal")) ?? "";
      ctx.set("journal", existing + entry);
    },

    readJournal: restate.handlers.object.shared(async (ctx: ObjectSharedContext) => {
      return (await ctx.get<string>("journal")) ?? null;
    }),

    enqueueMessage: async (ctx: ObjectContext, message: Envelope) => {
      const inbox = (await ctx.get<Envelope[]>("inbox")) ?? [];
      // Enqueue idempotence (§7.6): a retry with the same id replaces its
      // own envelope instead of duplicating it.
      const next = inbox.filter(m => m.id !== message.id);
      next.push(message);
      ctx.set("inbox", next);
      // A future-dated envelope arms a durable delayed self-check: when it
      // comes due, deliverDue revives the thread if no live process would
      // otherwise drain it.
      if (message.deliverAfter) {
        const delayMs = new Date(message.deliverAfter).getTime() - Date.now();
        if (delayMs > 0) {
          ctx
            .objectSendClient(ThreadObject, ctx.key)
            .deliverDue(message.id, restate.rpc.sendOpts({ delay: delayMs }));
        }
      }
    },

    drainInbox: async (ctx: ObjectContext): Promise<Envelope[]> => {
      const inbox = (await ctx.get<Envelope[]>("inbox")) ?? [];
      const now = Date.now();
      const due = inbox.filter(m => !m.deliverAfter || new Date(m.deliverAfter).getTime() <= now);
      const held = inbox.filter(m => m.deliverAfter && new Date(m.deliverAfter).getTime() > now);
      ctx.set("inbox", held);
      return due;
    },

    /**
     * Fired by the durable delayed send armed in enqueueMessage when a
     * deliverAfter envelope comes due. If the thread is live, its own
     * heartbeat drain picks the envelope up — no-op. If it's stopped, spawn
     * `pi` to revive it; the revived process drains the due envelope at boot.
     */
    deliverDue: async (ctx: ObjectContext, envelopeId: string) => {
      const inbox = (await ctx.get<Envelope[]>("inbox")) ?? [];
      const msg = inbox.find(m => m.id === envelopeId);
      if (!msg) return; // already drained (or cancelled by draining) — nothing to do
      const state = await ctx.get<StateFile>("state");
      if (!state) return;
      const isLive =
        state.status === "running" && Date.now() - new Date(state.lastSeen).getTime() < STALE_MS;
      if (isLive) return; // the running process's own heartbeat drain covers this
      await ctx.run("spawn pi to deliver due envelope", async () => {
        // state.cwd is the workspace the thread ran in — reviving it anywhere
        // else would put its work (and any .thread/ artifacts) in the wrong
        // place. stdio "ignore" attaches /dev/null, which `pi --print` needs:
        // it reads stdin to EOF and hangs forever on an open pipe.
        const launch = buildWakeLaunch(
          ctx.key,
          `[delayed envelope due #${msg.id}] — drain your inbox.`,
          state.cwd,
        );
        const proc = spawn(launch.cmd, launch.args, {
          cwd: launch.cwd,
          detached: true,
          stdio: "ignore",
        });
        proc.unref();
      });
    },
  },
});

export type ThreadObjectApi = typeof ThreadObject;
export type ThreadRegistryApi = typeof ThreadRegistry;

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT) || 9080;
  restate.serve({ services: [ThreadObject, ThreadRegistry], port }).then(
    boundPort => console.log(`[pi-threading] Restate service listening on port ${boundPort}`),
    err => {
      console.error("[pi-threading] Restate service failed to start:", err);
      process.exit(1);
    },
  );
}
