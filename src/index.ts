import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createThreadStore } from "./state";
import { createInbox } from "./inbox";
import { registerLifecycle } from "./lifecycle";
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { createConfiguredAdapter } from "./adapter/registry";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("thread-id", {
    type: "string",
    description: "Stable id for this thread, used for cross-thread addressing (e.g. thread-b)",
  });
  pi.registerFlag("thread-parent", {
    type: "string",
    description: "Parent thread id, for Blocker escalation",
  });
  pi.registerFlag("thread-role", {
    type: "string",
    description:
      "Role label for this thread (e.g. dev, qa) — targetable via thread_send role:<role>",
  });
  pi.registerFlag("thread-journal", {
    type: "string",
    description: 'Journal cadence: "turn" (default, one model call per turn), "done", or "off"',
  });
  pi.registerFlag("thread-storage", {
    type: "string",
    description: 'Storage backend: "local" (default) or "restate"',
  });
  pi.registerFlag("thread-storage-url", {
    type: "string",
    description: "Backend connection URL (e.g. Restate ingress URL) — ignored by the local backend",
  });

  const adapter = createConfiguredAdapter(pi);
  const store = createThreadStore(pi, adapter);
  const inbox = createInbox(store, pi);

  registerLifecycle(pi, store, inbox);
  registerTools(pi, store, inbox);
  registerCommands(pi, store, inbox);
}
