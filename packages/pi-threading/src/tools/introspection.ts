import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadStore } from "../core/types";
import { barrierLines, formatThreadLine, obligationLines, owedLines } from "../core/format";
import { splitJournalEntries } from "../journal";
import { err } from "./shared";
import { threadingTools } from "./index";

/** Read-only tools: this thread's status, the workspace roster, journals. */
export function registerIntrospectionTools(pi: ExtensionAPI, store: ThreadStore) {
  pi.registerTool({
    ...threadingTools.status,
    parameters: Type.Object({}),
    async execute() {
      const journal =
        (await store.readJournal(store.threadId)) ?? "(no journal yet — this is the first turn)";
      return {
        content: [
          {
            type: "text" as const,
            text: `Id: ${store.threadId}\nRole: ${store.role ?? "-"}\nState: ${store.state}${store.holdReason ? ` (${store.holdReason})` : ""}\nStatus: ${store.status}\nBarriers:${barrierLines(store.barriers)}\nObligations:${obligationLines(store.obligations)}\nOwed replies:${owedLines(store.owed)}\n\n${journal}`,
          },
        ],
        details: {
          id: store.threadId,
          role: store.role,
          state: store.state,
          status: store.status,
          holdReason: store.holdReason,
          obligations: store.obligations,
          owed: store.owed,
          barriers: store.barriers,
        },
      };
    },
  });

  pi.registerTool({
    ...threadingTools.list,
    parameters: Type.Object({}),
    async execute() {
      const threads = await store.listThreads();
      const lines = threads.map(formatThreadLine);
      return {
        content: [
          {
            type: "text" as const,
            text: lines.length ? lines.join("\n") : "(no other threads found)",
          },
        ],
        details: { threads },
      };
    },
  });

  pi.registerTool({
    ...threadingTools.journal,
    parameters: Type.Object({
      id: Type.String({
        description: "Thread id to read (see thread_list). Use your own id for your own journal.",
      }),
      tail: Type.Optional(
        Type.Number({
          description:
            "Only return the last N journal entries (each entry is one turn/session). Default: all.",
        }),
      ),
      lookbackMinutes: Type.Optional(
        Type.Number({
          description:
            "Only return entries timestamped within the last N minutes. Combine with tail to cap both age and count.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!store.adapter.readJournal) {
        return err("This storage backend has no journal channel (optional extension, §5).");
      }
      if (!(await store.threadExists(params.id))) {
        return err(`No thread "${params.id}" found. Call thread_list to see known ids.`);
      }
      let journal = (await store.readJournal(params.id)) ?? "(no journal entries yet)";
      if ((params.tail || params.lookbackMinutes) && journal) {
        let entries = splitJournalEntries(journal);
        if (params.lookbackMinutes) {
          const cutoff = Date.now() - params.lookbackMinutes * 60_000;
          entries = entries.filter(e => {
            const m = /^<!--\s*(.+?)\s*-->/.exec(e);
            if (!m) {
              return true;
            } // no timestamp — keep rather than silently drop
            const ts = new Date(m[1].replace(" ", "T") + ":00Z").getTime();
            return !Number.isFinite(ts) || ts >= cutoff;
          });
        }
        if (params.tail) {
          entries = entries.slice(-params.tail);
        }
        journal = entries.join("\n") || "(no entries in range)";
      }
      return {
        content: [{ type: "text" as const, text: `Journal for ${params.id}:\n\n${journal}` }],
        details: { ok: true, id: params.id, journal },
      };
    },
  });
}
