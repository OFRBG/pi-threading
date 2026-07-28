import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as localFs from "./local-fs";
import * as redis from "./redis";
import * as mongo from "./mongo";
import * as http from "./http";
import type { AdapterDefinition, AdapterOptions, PiFlagParam, ThreadAdapter } from "./types";
import type { ThreadingState } from "../context";

// Read (never register) the `thread-storage-*` flags for one adapter. Flags
// omitted on the CLI are left unset here — pi.getFlag returns the registered
// default for those, or undefined for a flag registered without one (see
// registerStorageFlags), in which case the adapter applies its own fallback.
function readFlags<TFlags extends Record<string, PiFlagParam>>(
  pi: ExtensionAPI,
  options: TFlags,
): AdapterOptions<TFlags> {
  const config: Record<string, string | boolean> = {};

  for (const flag of Object.keys(options)) {
    const value = pi.getFlag(`thread-storage-${flag}`);

    if (value !== undefined) {
      config[flag] = value;
    }
  }

  return config as AdapterOptions<TFlags>;
}

// Register the union of EVERY backend's flags, once, up front. pi validates
// argv against the registered flag set, and that validation happens after the
// extension's synchronous init but before `--thread-storage` can be read — so
// we cannot wait until we know which backend was selected to register only
// its flags (the bug that made `--thread-storage-connection-string` "unknown"
// unless the local backend happened to declare it). A flag name declared by
// more than one backend (redis and mongo both use `connection-string`) is
// registered once; when their defaults disagree the default is dropped and
// those adapters fall back to their own default internally, so a single
// shared flag can serve either backend without one's default leaking to the
// other.
function registerStorageFlags(pi: ExtensionAPI): void {
  const merged = new Map<string, PiFlagParam>();

  for (const def of adapterRegistry.values()) {
    for (const [option, param] of Object.entries(def.options)) {
      const existing = merged.get(option);
      if (!existing) {
        merged.set(option, param);
      } else if (existing.default !== param.default) {
        merged.set(option, { type: existing.type, description: existing.description });
      }
    }
  }

  for (const [option, param] of merged) {
    pi.registerFlag(`thread-storage-${option}`, param);
  }
}

export function registerAdapter<TFlags extends Record<string, PiFlagParam>>(
  name: string,
  options: TFlags,
  createAdapter: (options: AdapterOptions<TFlags>) => ThreadAdapter,
): void {
  adapterRegistry.set(name, {
    options,
    build: pi => createAdapter(readFlags(pi, options)),
  });
}

const adapterRegistry = new Map<string, AdapterDefinition>();

export function createAdapter(pi: ExtensionAPI, _: ThreadingState): ThreadAdapter {
  registerAdapter("local", localFs.options, localFs.createAdapter);
  registerAdapter("redis", redis.options, redis.createAdapter);
  registerAdapter("mongo", mongo.options, mongo.createAdapter);
  registerAdapter("http", http.options, http.createAdapter);

  registerStorageFlags(pi);

  // Deferred resolution: pi.getFlag values are not populated until AFTER
  // the extension's synchronous init finishes (applyExtensionFlagValues in
  // agent-session-services.js).  Reading `--thread-storage` here would
  // always return undefined.  Instead we build a lazy proxy that resolves
  // the real adapter on the first method call, by which time CLI flag
  // values are available.
  let real: ThreadAdapter | undefined;

  function resolve(): ThreadAdapter {
    if (real) {
      return real;
    }

    const name = pi.getFlag("thread-storage") as string;
    const def = adapterRegistry.get(name);

    if (!def) {
      const known = Array.from(adapterRegistry.keys()).join(", ");
      throw new Error(`Unknown --thread-storage "${name}". Known backends: ${known}.`);
    }

    return (real = def.build(pi));
  }

  const lazy: ThreadAdapter = {
    configure: () => resolve().configure(),
    loadState: id => resolve().loadState(id),
    saveState: (id, s) => resolve().saveState(id, s),
    listThreads: () => resolve().listThreads(),
    threadExists: id => resolve().threadExists(id),
    sendMail: m => resolve().sendMail(m),
    receiveMail: id => resolve().receiveMail(id),
    watchMail: (id, cb) => resolve().watchMail(id, cb),
  };

  return lazy;
}
