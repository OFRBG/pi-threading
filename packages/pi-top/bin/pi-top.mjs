#!/usr/bin/env node
/**
 * pi-top — htop-style TUI dashboard for pi-threading multi-agent systems.
 *
 * Blessed (the TUI library) has a terminfo parser that chokes on modern
 * xterm-256color entries (Setulc / underline-color capability). Setting
 * TERM=xterm avoids the problematic capability while keeping 256 colors.
 *
 * Usage: pi-top [--storage <backend>] [flags]
 *
 * Keybindings (full TUI):
 *   j / ↓        Move down
 *   k / ↑        Move up
 *   Enter        Inspect selected thread
 *   q / Ctrl-C   Quit
 */
process.env.TERM = "xterm";

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../dist/index.js";
import { startFallback } from "../dist/tui-fallback.js";
import { createStore } from "../dist/store.js";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function usage() {
  console.log(`pi-top v${VERSION} — htop-style TUI dashboard for pi-threading multi-agent systems

Usage:
  pi-top [--storage <backend>] [flags]

Storage backends:
  --storage local-fs        (default) Watch .thread/threads/ on local disk
  --storage redis           Watch a Redis instance
  --storage mongo           Watch a MongoDB instance
  --storage http            Watch a remote HTTP thread-store service

Backend flags:
  --dir <path>              Workspace root for local-fs (default: cwd)
  --redis-url <url>         Redis connection string (default: redis://localhost:6379)
  --mongo-url <url>         MongoDB connection string (default: mongodb://localhost:27017)
  --mongo-db <name>         MongoDB database name (default: pi-threading)
  --http-url <url>          HTTP service base URL (default: http://localhost:7777)

Display flags:
  --no-tui                  Disable TUI; use polling table output instead

Keybindings (TUI mode):
  j / ↓ / k / ↑              Navigate thread list
  Enter                       Inspect selected thread
  q / Ctrl-C                 Quit
`);
  process.exit(0);
}

const args = process.argv.slice(2);

const options = {
  storage: "local-fs",
  dir: process.cwd(),
  connectionString: undefined,
  database: "pi-threading",
};
let noTui = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--help":
    case "-h":
      usage(); // calls process.exit(0)
    case "--storage":
      options.storage = args[++i];
      break;
    case "--dir":
      options.dir = resolve(args[++i]);
      break;
    case "--redis-url":
      options.storage = "redis";
      options.connectionString = args[++i];
      break;
    case "--mongo-url":
      options.storage = "mongo";
      options.connectionString = args[++i];
      break;
    case "--mongo-db":
      options.database = args[++i];
      break;
    case "--http-url":
      options.storage = "http";
      options.connectionString = args[++i];
      break;
    case "--version":
    case "-v":
      console.log(`pi-top v${VERSION}`);
      process.exit(0);
    case "--no-tui":
      noTui = true;
      break;
    default:
      console.error(`pi-top: unknown flag "${a}". Use --help for usage.`);
      process.exit(1);
  }
}

if (noTui) {
  // Fallback mode: polling table, no TUI.
  // We use a mutable array that the fallback's render loop reads sync.
  const backend = await createStore(options);
  const threads = [];

  async function refresh() {
    try {
      const t = await backend.getThreads();
      threads.length = 0;
      threads.push(...t);
    } catch {
      /* ignore */
    }
  }

  await refresh();

  const provider = {
    getThreads: () => threads,
    getThread: () => null,
    getJournal: () => null,
    onUpdate: () => {}, // no-op; startFallback drives its own render loop
  };

  // startFallback renders every 2s, calling provider.getThreads() each time.
  // Give it a separate refresh timer so the array is always up to date.
  setInterval(refresh, 2000);

  startFallback(provider, () => process.exit(0));
} else {
  run(options).catch(err => {
    console.error("pi-top fatal:", err.stack ?? err.message);
    process.exit(1);
  });
}
