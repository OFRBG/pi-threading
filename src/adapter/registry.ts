import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as localFs from "./local-fs";
import * as redis from "./redis";
import * as mongo from "./mongo";
import * as http from "./http";
import type { AdapterDefinition, AdapterOptions, PiFlagParam, ThreadAdapter } from "./types";

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

/** Register every known backend and the union of their `thread-storage-*`
 *  flags. Call this once, synchronously, from the extension's top-level
 *  init (`index.ts`) — pi validates CLI args against the registered flag set
 *  before any flag value can be read back, so every backend's flags must be
 *  registered regardless of which one ends up selected; registering only
 *  the selected backend's flags is what previously made
 *  `--thread-storage-connection-string` "unknown" whenever `local` (the
 *  default) happened to be picked instead of `redis`/`mongo`.
 *
 *  A flag name declared by more than one backend (`redis` and `mongo` both
 *  use `connection-string`) is registered once; when their defaults
 *  disagree the default is dropped so neither backend's default leaks to
 *  the other — each adapter falls back to its own default internally. */
export function registerStorageFlags(pi: ExtensionAPI): void {
  registerAdapter("local", localFs.options, localFs.createAdapter);
  registerAdapter("redis", redis.options, redis.createAdapter);
  registerAdapter("mongo", mongo.options, mongo.createAdapter);
  registerAdapter("http", http.options, http.createAdapter);

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

/** Build the backend named by `--thread-storage`. Must not be called until
 *  pi has populated flag values — which happens after the extension's
 *  top-level init returns, not during it (the same reason `store.init()` in
 *  `state.ts`, not this module's caller, is where `--thread-id`/
 *  `--thread-role`/`--thread-parent` are first read). Callers defer this
 *  call to that same moment; see `state.ts`'s `adapter` getter. */
export function resolveAdapter(pi: ExtensionAPI): ThreadAdapter {
  const name = (pi.getFlag("thread-storage") as string | undefined) ?? "local";
  const def = adapterRegistry.get(name);

  if (!def) {
    const known = Array.from(adapterRegistry.keys()).join(", ");
    throw new Error(`Unknown --thread-storage "${name}". Known backends: ${known}.`);
  }

  return def.build(pi);
}
