/**
 * store.ts — factory that creates the right backend based on --storage flag.
 *
 * Supported backends:
 *   local-fs  (default)  — reads .thread/threads/<id>/state.json
 *   redis                — reads thread:* keys from a Redis instance
 *   mongo                — reads states/journal collections from MongoDB
 *   http                 — calls a remote thread-store REST API
 */

import { createLocalStore } from "./store-local";
import { createRedisStore } from "./store-redis";
import { createMongoStore } from "./store-mongo";
import { createHttpStore } from "./store-http";
import type { ThreadStoreBackend } from "./store-types";

export type { ThreadStoreBackend } from "./store-types";

export interface StoreOptions {
  storage: "local-fs" | "redis" | "mongo" | "http";
  /** Workspace root for local-fs (default: process.cwd()). */
  dir: string;
  /** Connection string for redis / mongo / http backends. */
  connectionString?: string;
  /** Database name for mongo backend. */
  database?: string;
}

export async function createStore(options: StoreOptions): Promise<ThreadStoreBackend> {
  switch (options.storage) {
    case "local-fs":
      return createLocalStore(options.dir);
    case "redis":
      return createRedisStore(options.connectionString ?? "redis://localhost:6379");
    case "mongo":
      return createMongoStore(
        options.connectionString ?? "mongodb://localhost:27017",
        options.database ?? "pi-threading",
      );
    case "http":
      return createHttpStore(options.connectionString ?? "http://localhost:7777");
  }
}
