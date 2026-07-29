# pi-threading (monorepo)

Cross-thread communication for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — independent `pi` processes that coordinate work, share state, and converse without losing context.

This is a pnpm workspace with three packages:

| Package                                          | What it is                                                                    | Install                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------- |
| [`pi-threading`](packages/pi-threading)          | The extension itself — threads, mailboxes, journaling, storage backends       | `pi install npm:pi-threading` |
| [`@pi-threading/cli`](packages/pi-threading-cli) | Zero-dependency CLI to monitor and steer a thread system without running `pi` | `npx @pi-threading/cli`       |
| [`@pi-threading/top`](packages/pi-top)           | htop-style TUI dashboard for live thread monitoring                           | `npx @pi-threading/top`       |

Start with `packages/pi-threading`'s [README](packages/pi-threading/README.md) — it covers installing the extension, the thread lifecycle, slash commands and tools (including `/thread-launch`, `/thread-spawn`, `/thread-shutdown`), and the storage backends (local filesystem, Redis, MongoDB, HTTP). The design and protocol rationale live in [THREAD-MODEL.md](packages/pi-threading/THREAD-MODEL.md).

`pi-threading` publishes unscoped (it's the established `pi install npm:pi-threading` identity); the CLI and TUI dashboard publish under the `@pi-threading` npm org scope.

## Development

```bash
pnpm install
pnpm run lint          # oxlint, every package
pnpm run test:unit     # offline unit tests, every package
pnpm --filter pi-threading exec tsc --noEmit
pnpm --filter ./packages/pi-top exec tsc --noEmit
```

Each package also has its own scripts (`pnpm --filter <package> run <script>`, or `cd packages/<name>` and run them directly) — see each package's own README/`package.json`.

## Release

Each package versions and publishes independently. Pushing a tag of the form
`<folder>@<version>` (e.g. `pi-top@0.1.0`) — where `<folder>` is the
directory name under `packages/`, not necessarily the published npm name —
triggers `.github/workflows/release.yml` to publish that one package to
npmjs and to the GitHub npm registry (mirror, under `@ofrbg/<folder>`). See
that workflow's header comment for the one-time setup a brand-new package
needs before its first tag-triggered publish will work.

## License

MIT
