import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThreadingContext } from "../context";
import type { CommandDefinition } from "./shared";
import { threadStatus } from "./thread-status";
import { threadList } from "./thread-list";
import { threadSend } from "./thread-send";
import { threadSuspend } from "./thread-suspend";
import { threadResume } from "./thread-resume";

const commands: CommandDefinition[] = [
  threadStatus,
  threadList,
  threadSend,
  threadSuspend,
  threadResume,
];

const requireActiveThread = (
  threading: ThreadingContext,
  ctx: ExtensionCommandContext,
  handler: (
    threading: ThreadingContext,
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>,
): ((args: string, ctx: ExtensionCommandContext) => Promise<void>) => {
  if (!threading.state.active) {
    ctx.ui.notify("pi-threading is disabled because no thread-id is set.", "warning");
    return () => Promise.resolve();
  }

  return (args, ctx) => handler(threading, args, ctx);
};

export function registerCommands(threading: ThreadingContext) {
  for (const { name, description, handler } of commands) {
    threading.pi.registerCommand(name, {
      description,
      handler: (args, ctx) => requireActiveThread(threading, ctx, handler)(args, ctx),
    });
  }
}
