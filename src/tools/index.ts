import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThreadStore } from "../core/types";
import type { Inbox } from "../inbox";
import { registerIntrospectionTools } from "./introspection";
import { registerMessagingTools } from "./messaging";
import { registerSyncTools } from "./sync";
import { registerControlTools } from "./control";

export function registerTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerSyncTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
}
