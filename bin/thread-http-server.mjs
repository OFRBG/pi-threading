#!/usr/bin/env node
// thread-http-server.mjs — launches the minimal, dependency-free reference
// server for the `http` storage adapter (src/adapter/http-server.ts). This
// is an in-memory, no-auth development/testing backend (see
// src/adapter/http-server.ts's `checkAuth` for where real auth would slot
// in) — not a production service. Run via `npm run http-server`, or
// directly: `node --import tsx bin/thread-http-server.mjs [port]`.
import { startServer } from "../src/adapter/http-server.ts";

const port = Number(process.env.PORT ?? process.argv[2] ?? 7777);

const { url } = await startServer(port);
console.log(`[thread-http-server] listening on ${url}`);
