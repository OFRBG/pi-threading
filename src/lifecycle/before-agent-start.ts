import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { threadModelPrompt } from "../core/system-prompt";
import type { ThreadingHookHandler } from "./shared";

export const beforeAgentStart: ThreadingHookHandler<
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult
> = async ({ store }, event) => {
  return {
    systemPrompt: event.systemPrompt + "\n\n" + threadModelPrompt(store),
  };
};
