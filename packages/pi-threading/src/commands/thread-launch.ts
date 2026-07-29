import * as path from "node:path";
import type { CommandDefinition } from "./shared";
import { launchTeam } from "../core/launch";

export const threadLaunch: CommandDefinition = {
  name: "thread-launch",
  description: "Spin up a team of threads from a JSON config: /thread-launch [path]",
  async handler({ store }, args, ctx) {
    const configPath = path.resolve(process.cwd(), args.trim() || ".thread/team.json");

    let report;
    try {
      report = await launchTeam(store, configPath);
    } catch (e) {
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      return;
    }

    for (const warning of report.warnings) {
      ctx.ui.notify(warning, "warning");
    }
    for (const outcome of report.outcomes) {
      ctx.ui.notify(`${outcome.id}: ${outcome.message}`, outcome.ok ? "info" : "warning");
    }
  },
};
