import * as restate from "@restatedev/restate-sdk";
import type { ObjectContext, ObjectSharedContext } from "@restatedev/restate-sdk";
import { spawn } from "node:child_process";
import type { StateFile, InboxMessage, ScheduledWake } from "../core/types";
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
 * inbox in Restate's per-key state instead of files on disk.
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

    enqueueMessage: async (ctx: ObjectContext, message: InboxMessage) => {
      const inbox = (await ctx.get<InboxMessage[]>("inbox")) ?? [];
      inbox.push(message);
      ctx.set("inbox", inbox);
    },

    drainInbox: async (ctx: ObjectContext): Promise<InboxMessage[]> => {
      const inbox = (await ctx.get<InboxMessage[]>("inbox")) ?? [];
      ctx.set("inbox", []);
      return inbox;
    },

    /**
     * Invoked by Restate's own durable delayed-send (armed via
     * RestateAdapter.scheduleWake's `rpc.sendOpts({ delay })`) — this is the
     * one thing the local-fs backend can never do: fire even if the `pi`
     * process that armed it has since exited. Spawns `pi` to actually wake
     * the thread if it isn't currently live.
     *
     * Cancellation caveat: Restate's public client API has no "cancel a
     * delayed send" call, so a cancelled wake still fires this handler at
     * the original time — it re-checks the *current* persisted schedules
     * list and no-ops if the wake was removed (RestateAdapter.cancelWake
     * strips it from state) or already nudged.
     */
    fireWake: async (ctx: ObjectContext, wake: ScheduledWake) => {
      const state = await ctx.get<StateFile>("state");
      if (!state) return;
      const current = state.schedules.find(w => w.id === wake.id);
      if (!current || current.nudged) return;
      current.nudged = true;
      ctx.set("state", state);

      const isLive =
        state.status === "running" && Date.now() - new Date(state.lastSeen).getTime() < STALE_MS;
      if (isLive) return; // the running process's own heartbeat/checkSchedules already covers this
      await ctx.run("spawn pi to wake stopped thread", async () => {
        // state.cwd is the workspace the thread ran in — reviving it anywhere
        // else would put its work (and any .thread/ artifacts) in the wrong
        // place. stdio "ignore" attaches /dev/null, which `pi --print` needs:
        // it reads stdin to EOF and hangs forever on an open pipe.
        const launch = buildWakeLaunch(ctx.key, wake, state.cwd);
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
