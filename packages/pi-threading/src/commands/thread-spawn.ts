import type { CommandDefinition } from "./shared";
import { spawnThread, type LaunchMode } from "../core/launch";

const FLAG_KEYS = new Set(["role", "parent", "model", "provider", "journal-model", "mode"]);

function parseSpawnArgs(args: string): {
  id?: string;
  flags: Partial<Record<string, string>>;
  prompt: string;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const id = tokens.shift();
  const flags: Partial<Record<string, string>> = {};
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const key = token.startsWith("--") ? token.slice(2) : undefined;
    if (key && FLAG_KEYS.has(key)) {
      flags[key] = tokens[++i] ?? "";
    } else {
      rest.push(token);
    }
  }

  return { id, flags, prompt: rest.join(" ") };
}

export const threadSpawn: CommandDefinition = {
  name: "thread-spawn",
  description:
    "Spin up a single new thread, parented to this one, no config file needed: /thread-spawn <id> [--role r] [--model m] [--parent p] [--mode tmux|background] [prompt...]",
  async handler({ store }, args, ctx) {
    const { id, flags, prompt } = parseSpawnArgs(args);

    if (!id) {
      ctx.ui.notify(
        "Usage: /thread-spawn <id> [--role r] [--model m] [--parent p] [--mode tmux|background] [prompt...]",
        "warning",
      );
      return;
    }

    const outcome = await spawnThread(store, {
      id,
      role: flags.role,
      parent: flags.parent,
      model: flags.model,
      provider: flags.provider,
      journalModel: flags["journal-model"],
      mode: flags.mode as LaunchMode | undefined,
      prompt: prompt || undefined,
    });

    ctx.ui.notify(`${outcome.id}: ${outcome.message}`, outcome.ok ? "info" : "warning");
  },
};
