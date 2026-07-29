import type { ThreadingContext } from "../context";
import { registerIntrospectionTools } from "./introspection";
import { registerMessagingTools } from "./messaging";
import { registerControlTools } from "./control";
import { registerSpawnTools } from "./spawn";

/** The static half of a tool: identity and copy. Spread into the
 *  `pi.registerTool` call alongside its `parameters` and `execute`. */
export interface ThreadingToolDef {
  name: string;
  label: string;
  description: string;
}

/** Every threading tool's name/label/description in one place, so the copy
 *  can be edited without hunting through the impl files. Each is spread into
 *  its `pi.registerTool({ ...def, parameters, execute })` call. */
export const threadingTools = {
  status: {
    name: "thread_status",
    label: "Thread Status",
    description:
      "Read this thread's own state and journal. Use this to understand what you were doing before a compaction, and to recover the envelope ids you owe replies to.",
  },
  list: {
    name: "thread_list",
    label: "Thread List",
    description:
      "List all known threads sharing this workspace and their last known state. Use this to find a valid `to` id before calling thread_send.",
  },
  journal: {
    name: "thread_journal",
    label: "Thread Journal",
    description:
      "Read another thread's journal (or your own) without messaging it — the self-written status trail visible via thread_status, but for anyone. Use to check what a teammate has been doing before deciding whether to interrupt them.",
  },
  send: {
    name: "thread_send",
    label: "Thread Send",
    description:
      'Send a message to other thread(s). `to` accepts a thread id, a comma-separated list, `*` (all known threads), or `role:<role>` — see thread_list. Set expects=true when you need a reply (a "request" — tracked as an obligation until the reply lands). Set re=<id> to reply to a message you received (this discharges the debt). Both together = a reply that asks a follow-up. Neither = a plain note. To your parent with expects=true and urgency="high" = an escalation. A future-dated send to your OWN id (deliverAfterSeconds) is a scheduled self-wake.',
  },
  wait: {
    name: "thread_wait",
    label: "Thread Wait",
    description:
      "Wait for replies to outstanding requests (envelope ids from thread_send results / thread_status). When all (or any) of them receive a reply, you get a wake-up message — optionally with your own `message` payload injected alongside it. Non-blocking: end your turn after calling this.",
  },
  suspend: {
    name: "thread_suspend",
    label: "Thread Suspend",
    description:
      "Mark this thread On Hold. Cooperative — does not stop the process, just records suspended state for a human/harness to act on. Inbox messages queue until resume.",
  },
  resume: {
    name: "thread_resume",
    label: "Thread Resume",
    description: "Resume this thread from On Hold back to Open.",
  },
  launch: {
    name: "thread_launch",
    label: "Thread Launch",
    description:
      'Spin up a team of threads from a JSON config (default ".thread/team.json"): each entry becomes its own pi process with its own id/role/parent/model/system-prompt. Use this to delegate work to a fresh team rather than doing it all yourself. Skips this thread\'s own id and any id that already exists.',
  },
  spawn: {
    name: "thread_spawn",
    label: "Thread Spawn",
    description:
      "Spin up a single new thread ad hoc — no config file needed, like spawning a subagent. Its parent defaults to you, so it escalates back to you when stuck. Optionally set role/model/provider and a system-prompt piece (the task brief). Skips if the id already exists.",
  },
  shutdown: {
    name: "thread_shutdown",
    label: "Thread Shutdown",
    description:
      'Signal thread(s) to stop. `to` accepts a thread id, comma list, "*", or "role:<role>" — see thread_list. Sends SIGTERM by default (graceful — the target still runs its own shutdown hook); set force=true for SIGKILL. Cannot target yourself.',
  },
} satisfies Record<string, ThreadingToolDef>;

/** All threading tool names — used to filter the active tool set when a
 *  session has no thread id. */
export const threadingToolNames: string[] = Object.values(threadingTools).map(t => t.name);

export function registerTools({ pi, store, inbox }: ThreadingContext) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
  registerSpawnTools(pi, store, inbox);
}
