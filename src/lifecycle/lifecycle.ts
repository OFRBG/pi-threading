import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadingContext } from "../context";
import type { ThreadingHookHandler } from "./shared";
import { sessionStart } from "./session-start";
import { sessionBeforeCompact } from "./session-before-compact";
import { sessionCompact } from "./session-compact";
import { sessionShutdown } from "./session-shutdown";
import { turnStart } from "./turn-start";
import { toolExecutionStart } from "./tool-execution-start";
import { turnEnd } from "./turn-end";
import { agentEnd } from "./agent-end";
import { beforeAgentStart } from "./before-agent-start";

type HookHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

const requireActive =
  <E, R>(threading: ThreadingContext, handler: ThreadingHookHandler<E, R>): HookHandler<E, R> =>
  async (event, ctx) => {
    if (!threading.state.active) {
      if (!threading.state.noThreadIdWarningShown) {
        threading.state.noThreadIdWarningShown = true;
        ctx.ui.notify("pi-threading is disabled because no thread-id is set.", "warning");
      }
      return;
    }

    return handler(threading, event, ctx);
  };

export function registerLifecycle(threading: ThreadingContext) {
  const { pi } = threading;

  pi.on("session_start", (event, ctx) => sessionStart(threading, event, ctx));
  pi.on("session_before_compact", requireActive(threading, sessionBeforeCompact));
  pi.on("session_compact", requireActive(threading, sessionCompact));
  pi.on("session_shutdown", requireActive(threading, sessionShutdown));
  pi.on("turn_start", requireActive(threading, turnStart));
  pi.on("tool_execution_start", requireActive(threading, toolExecutionStart));
  pi.on("turn_end", requireActive(threading, turnEnd));
  pi.on("agent_end", requireActive(threading, agentEnd));
  pi.on("before_agent_start", requireActive(threading, beforeAgentStart));
}
