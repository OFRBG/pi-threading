import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as localFs from "./local-fs";
import type { AdapterDefinition, AdapterOptions, PiFlagParam, ThreadAdapter } from "./types";

function loadFlags<TFlags extends Record<string, PiFlagParam>>(
  pi: ExtensionAPI,
  options: TFlags,
): AdapterOptions<TFlags> {
  const config: Record<string, string | boolean> = {};

  for (const [option, param] of Object.entries(options)) {
    pi.registerFlag(`thread-storage-${option}`, param);
  }

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
    build: pi => createAdapter(loadFlags(pi, options)),
  });
}

const adapterRegistry = new Map<string, AdapterDefinition>();

export function createAdapter(pi: ExtensionAPI): ThreadAdapter {
  registerAdapter("local", localFs.options, localFs.createAdapter);

  registerAdapter(
    "mongo",
    {
      "connection-string": {
        type: "string",
        description:
          "(Storage: mongo) Connection string for MongoDB storage. Default: mongodb://localhost:27017.",
        default: "mongodb://localhost:27017",
      },
    } satisfies Record<string, PiFlagParam>,
    ({ "connection-string": _connectionString }) => {
      throw new Error("MongoDB adapter not implemented yet.");
    },
  );

  const storage = pi.getFlag("thread-storage");
  const name = typeof storage === "string" && adapterRegistry.has(storage) ? storage : "local";
  const adapter = adapterRegistry.get(name);

  if (!adapter) {
    const known = Array.from(adapterRegistry.keys()).join(", ");
    throw new Error(`Unknown --thread-storage "${name}". Known backends: ${known}.`);
  }

  return adapter.build(pi);
}
