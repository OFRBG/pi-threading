import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStore as createStore } from "./state";
import { createInbox } from "./inbox";
import { registerLifecycle } from "./lifecycle";
import { registerTools } from "./tools/index";
import { registerCommands } from "./commands";
import { createAdapter as createAdapter } from "./adapter/registry";
import type { ThreadingContext } from "./context";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("thread-id", {
    type: "string",
    description: "The ID of the current agent thread. Targetable via thread_send thread:<id>.",
  });
  pi.registerFlag("thread-parent", {
    type: "string",
    description: "The ID of the parent thread. This is used for Blocker request escalation.",
  });
  pi.registerFlag("thread-role", {
    type: "string",
    description: "Role label for this thread. Targetable via thread_send role:<role>",
  });
  pi.registerFlag("thread-journal", {
    type: "string",
    description: 'Journal entry cadence: "turn" (default), "done", or "off"',
  });
  pi.registerFlag("thread-journal-model", {
    type: "string",
    description: "Model for journal entry writing. Defaults to the thread's own model.",
  });
  pi.registerFlag("thread-storage", {
    type: "string",
    description: 'Storage backend: "local" (default)',
  });

  const adapter = createAdapter(pi);
  const store = createStore(pi, adapter);
  const inbox = createInbox(store, pi);

  const threading: ThreadingContext = {
    pi,
    store,
    inbox,
    state: { active: false, toolUsedThisTurn: false },
  };

  registerLifecycle(threading);
  registerTools(threading);
  registerCommands(threading);
}
