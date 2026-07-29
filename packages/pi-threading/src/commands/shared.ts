import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThreadingContext } from "../context";

export type CommandDefinition = {
  name: string;
  description: string;
  handler: (
    threading: ThreadingContext,
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
};
