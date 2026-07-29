# pi-top 🎛️

**htop-style TUI dashboard for pi-threading multi-agent systems.**

Monitor live agent threads, inspect their state, obligations, and journals — all from your terminal.

```
┌─ pi-top — Thread Dashboard ─────────────────────────────────┐
│  ● t1    open      2s    ● t3    on-hold  12s               │
│  ○ helper working  5s    ○ t4    done      2m               │
│                                                             │
│  ── Detail: t1 ──────────────────────────────────────────── │
│  State:     Open    (running)                                │
│  Role:      coordinator                                      │
│  Parent:    —                                                 │
│  Last Seen: 2s ago                                           │
│                                                             │
│  ── Obligations (1) ──                                       │
│  → helper: "Reply with your findings" — due in 8m            │
│                                                             │
│  ── Journal ──                                               │
│  [21:15] Started task: Research data sources                  │
│  [21:16] Sent message to helper                               │
├──────────────────────────────────────────────────────────────┤
│  4 threads (2 running)  ↑↓ j/k  Enter  ?  q                │
└──────────────────────────────────────────────────────────────┘
```

## Compared to `pi-threading-cli watch`

The existing `pi-threading-cli` package has a `watch` command that prints a flat
ANSI table to the terminal every 2 seconds. It's useful for a quick overview,
but it's a one-way output — no keyboard interaction, no detail inspection, no
state coloring.

`pi-top` is the evolution of that idea:

| Feature      | `pi-threading-cli watch` | `pi-top`                                           |
| ------------ | ------------------------ | -------------------------------------------------- |
| Display      | Flat ANSI table          | Split-panel TUI with colored states                |
| Navigation   | None (scrolls output)    | `j/k/↑↓` to navigate, Enter to inspect             |
| Detail view  | None                     | Full thread detail panel with obligations, journal |
| State colors | No                       | Green/yellow/red/gray dots                         |
| Backends     | local-fs only            | local-fs, redis, mongo, http                       |
| Non-TTY mode | Yes (it's the only mode) | `--no-tui` flag                                    |
| Help overlay | No                       | `?` key toggles help                               |

## Features

- **Live thread list** — color-coded by state (● open, ◐ working, ◌ on hold, ○ idle/done)
- **Detail panel** — inspect selected thread's obligations, owed replies, barriers, and journal
- **Real-time updates** — `fs.watch` + polling fallback, so you never miss state changes
- **Multiple backends** — works with local-fs, Redis, MongoDB, or HTTP storage
- **Vim keybindings** — `j/k` to navigate, `Enter` to inspect, `?` for help, `q` to quit
- **Stale detection** — threads that haven't been seen in >60s are flagged with ⚠

## Install

```bash
# From the monorepo
cd packages/pi-top
pnpm install

# Or install as a standalone package
npm install @pi-threading/top
```

## Usage

```bash
# Watch the current directory for .thread/threads/
node --import tsx bin/pi-top.mjs

# Watch a specific workspace
node --import tsx bin/pi-top.mjs --dir /path/to/project

# Use a different storage backend
node --import tsx bin/pi-top.mjs --storage redis --redis-url redis://localhost:6379
node --import tsx bin/pi-top.mjs --storage mongo --mongo-url mongodb://localhost:27017
node --import tsx bin/pi-top.mjs --storage http --http-url http://localhost:7777
```

## Storage Backends

| Backend  | Flag                | Default                     | Watch Mechanism          |
| -------- | ------------------- | --------------------------- | ------------------------ |
| local-fs | `--dir <path>`      | `process.cwd()`             | `fs.watch` + 2s polling  |
| redis    | `--redis-url <url>` | `redis://localhost:6379`    | Pub/sub + 5s polling     |
| mongo    | `--mongo-url <url>` | `mongodb://localhost:27017` | Change streams / polling |
| http     | `--http-url <url>`  | `http://localhost:7777`     | Long-poll / 2s polling   |

## Keybindings

| Key            | Action                   |
| -------------- | ------------------------ |
| `↑` / `k`      | Move up in thread list   |
| `↓` / `j`      | Move down in thread list |
| `g`            | Go to first thread       |
| `G`            | Go to last thread        |
| `Enter`        | Inspect selected thread  |
| `Tab`          | Cycle focus              |
| `r`            | Force refresh            |
| `?` / `h`      | Toggle help overlay      |
| `q` / `Ctrl-C` | Quit                     |

## Development

```bash
# Type-check
pnpm run typecheck

# Lint
pnpm run lint

# Run in dev mode with file watching
pnpm run dev
```

## Project Structure

```
pi-top/
├── bin/pi-top.mjs          # CLI entry point
├── src/
│   ├── index.ts            # Bootstrap: backend → cache → TUI
│   ├── types.ts            # ThreadState, ThreadSummary, ThreadDetail
│   ├── store.ts            # Backend factory (local-fs, redis, mongo, http)
│   ├── store-*.ts          # Individual backend implementations
│   ├── store-types.ts      # Backend interface
│   ├── watcher.ts          # Backend-aware watcher
│   ├── watch-impl.ts       # Polling utility
│   ├── tui-fallback.ts     # ANSI table fallback (non-TTY)
│   └── tui/
│       ├── app.ts          # Blessed screen, layouts, keybindings
│       ├── thread-list.ts  # Left panel: thread list
│       └── detail-panel.ts # Right panel: thread detail
└── package.json
```

## v0.2 Roadmap

- Message flow visualization (directed edges between threads)
- Timeline view (scroll through message history)
- Inline message inspection
- Thread kill/resume from the dashboard
- Session log export

## License

MIT
