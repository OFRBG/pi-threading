import type { ThreadingContext } from "../context";
import { registerIntrospectionTools } from "./introspection";
import { registerMessagingTools } from "./messaging";
import { registerControlTools } from "./control";

export enum ThreadingTool {
  Status = "thread_status",
  List = "thread_list",
  Journal = "thread_journal",
  Send = "thread_send",
  Wait = "thread_wait",
  Suspend = "thread_suspend",
  Resume = "thread_resume",
}

export function registerTools({ pi, store, inbox }: ThreadingContext) {
  registerIntrospectionTools(pi, store);
  registerMessagingTools(pi, store, inbox);
  registerControlTools(pi, store, inbox);
}
