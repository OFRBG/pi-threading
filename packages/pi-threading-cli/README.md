# @pi-threading/cli

Zero-dependency CLI to monitor and steer a [pi-threading](https://github.com/OFRBG/pi-threading/tree/main/packages/pi-threading) multi-agent thread system — without running `pi` at all. A single-file Node script (`bin/thread-cli.mjs`) that speaks the same on-disk envelope/state format the extension does, so a human is a full peer in the thread system: reading state, tailing journals, and sending/replying to messages.

> Only sees threads running against the `local` storage backend — it speaks the file binding directly rather than going through pi-threading's `StorageAdapter`, so threads coordinating over Redis/Mongo/HTTP are invisible to it.

## Install

```bash
npx @pi-threading/cli <command> ...   # no install needed
# or
npm install -g @pi-threading/cli
```

## Commands

```bash
npx @pi-threading/cli list                      # table of all threads incl. coordination counts
npx @pi-threading/cli status link               # one thread's full coordination state:
                                                 #   obligations, owed replies, barriers,
                                                 #   pending inbox, last journal entry
npx @pi-threading/cli status link --json        # same, as machine-readable JSON
npx @pi-threading/cli watch                     # live coordination board
npx @pi-threading/cli tail link                 # follow one thread's state/journal/messages
                                                 #   (incl. +/- diffs of obligations/barriers)
npx @pi-threading/cli inbox link                # pending + recent messages
npx @pi-threading/cli send link "status?" --expects       # ask, tracked — thread owes you a reply
npx @pi-threading/cli send link "looks good" --re link/01ABC…  # reply, settles the debt
npx @pi-threading/cli send '*' "standup in 5"             # broadcast note
npx @pi-threading/cli delete link                         # remove a thread (refuses if it looks live)
npx @pi-threading/cli delete --stale --yes                # prune every stopped/stale thread
```

Global flag: `--dir <path>` — workspace root to read `.thread/` from (default: current directory).

Full flag reference: `npx @pi-threading/cli --help`.

## Why a separate, zero-dependency package

It's deliberately a single-file script with no dependencies and no build step, so it can be dropped onto any machine and just run. That's also why it can't `import` from the `pi-threading` extension package (which pulls in `@earendil-works/pi-coding-agent`, `typebox`, TS build tooling) — it reimplements the pieces of the on-disk envelope/state format it needs directly against `fs`. See [THREAD-MODEL.md](https://github.com/OFRBG/pi-threading/blob/main/packages/pi-threading/THREAD-MODEL.md) for the full protocol rationale.

## License

MIT
