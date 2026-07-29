import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadStore } from "../core/types";
import { launchTeam, shutdownThread, spawnThread, type LaunchMode } from "../core/launch";
import type { Inbox } from "../inbox";
import { err } from "./shared";
import { threadingTools } from "./index";

/** Process-lifecycle tools: spinning up a team from a config, and signaling
 *  launched (or any) threads to stop. The agent-callable counterpart to the
 *  human-triggered `/thread-launch` and `/thread-shutdown` commands — both
 *  surfaces call the same `core/launch.ts` functions so behavior never
 *  drifts between them. */
export function registerSpawnTools(pi: ExtensionAPI, store: ThreadStore, inbox: Inbox) {
  pi.registerTool({
    ...threadingTools.launch,
    parameters: Type.Object({
      config: Type.Optional(
        Type.String({
          description: 'Path to the team config JSON. Default: ".thread/team.json".',
        }),
      ),
    }),
    async execute(_id, params) {
      const configPath = path.resolve(process.cwd(), params.config?.trim() || ".thread/team.json");

      let report;
      try {
        report = await launchTeam(store, configPath);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const lines = [
        ...report.warnings.map(w => `Warning: ${w}`),
        ...report.outcomes.map(o => `${o.id}: ${o.message}`),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "No threads to launch." }],
        details: {
          ok: true,
          mode: report.mode,
          warnings: report.warnings,
          outcomes: report.outcomes,
        },
      };
    },
  });

  pi.registerTool({
    ...threadingTools.shutdown,
    parameters: Type.Object({
      to: Type.String({
        description: 'Target: thread id, "a,b,c", "*", or "role:<role>". Cannot target yourself.',
      }),
      force: Type.Optional(
        Type.Boolean({
          description: "Send SIGKILL instead of the default, graceful SIGTERM.",
        }),
      ),
    }),
    async execute(_id, params) {
      let targets: string[];
      try {
        targets = await inbox.resolveTargets(params.to);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      if (!targets.length) {
        return err(`No matching targets for "${params.to}".`);
      }

      const outcomes = [];
      for (const id of targets) {
        outcomes.push(await shutdownThread(store, id, { force: params.force === true }));
      }

      return {
        content: [
          { type: "text" as const, text: outcomes.map(o => `${o.id}: ${o.message}`).join("\n") },
        ],
        details: { ok: true, outcomes },
      };
    },
  });

  pi.registerTool({
    ...threadingTools.spawn,
    parameters: Type.Object({
      id: Type.String({ description: "Id for the new thread." }),
      role: Type.Optional(
        Type.String({ description: "Role label, targetable via thread_send role:<role>." }),
      ),
      parent: Type.Optional(
        Type.String({ description: "Parent thread id. Default: you (the spawning thread)." }),
      ),
      model: Type.Optional(Type.String({ description: "Model override. Default: inherited." })),
      provider: Type.Optional(
        Type.String({ description: "Provider override. Default: inherited." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description: "The task brief: inline text, appended as its system prompt.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("tmux"), Type.Literal("background")], {
          description: 'Default: "tmux" (falls back to "background" if tmux is unavailable).',
        }),
      ),
    }),
    async execute(_id, params) {
      let outcome;
      try {
        outcome = await spawnThread(store, {
          id: params.id,
          role: params.role,
          parent: params.parent,
          model: params.model,
          provider: params.provider,
          prompt: params.prompt,
          mode: params.mode as LaunchMode | undefined,
        });
      } catch (e) {
        return err(`${params.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!outcome.ok) {
        return err(`${outcome.id}: ${outcome.message}`);
      }

      return {
        content: [{ type: "text" as const, text: `${outcome.id}: ${outcome.message}` }],
        details: { ok: true, outcome },
      };
    },
  });
}
