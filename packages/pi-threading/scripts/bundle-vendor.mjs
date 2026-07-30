#!/usr/bin/env node
/**
 * Pre-bundles ioredis and mongodb into single self-contained files under
 * vendor/, so the redis/mongo adapters never `import`/`require` an external
 * package *by name* at runtime — only a relative path to a file we ship
 * ourselves.
 *
 * Why: under pi's compiled-Bun-binary distribution, the extension loader
 * fails to resolve npm dependencies by name from node_modules even when
 * they're installed correctly (confirmed: earendil-works/pi#6455, #5949 —
 * a Bun limitation, not something pi or pi-threading can fix directly).
 * Relative-path resolution to files inside the extension's own directory
 * works fine under the same broken loader (the whole extension — index.ts,
 * every ./adapter/*.ts — loads that way already). Bundling turns "resolve
 * ioredis by name" into "resolve ./vendor/ioredis.mjs by path", sidestepping
 * the bug entirely regardless of how pi/Bun ever fixes (or doesn't fix) the
 * underlying resolver issue.
 *
 * ioredis has no native bindings and bundles cleanly as-is. mongodb's
 * driver has several *optional* peer dependencies (compression, Kerberos/
 * AWS auth) that it `require()`s dynamically and gracefully skips if
 * missing — marked --external below so esbuild doesn't try to bundle them;
 * at runtime the driver's own optional-dependency handling takes over
 * exactly as it would for a normal npm install missing those extras.
 *
 * Bundled to CJS (.cjs), not ESM, despite this package being "type":
 * "module" — mongodb's own source has plain `require("timers/promises")`
 * calls (sessions.js, execute_operation.js, mongodb_oidc/callback_workflow.js)
 * for a genuine Node builtin. esbuild's ESM output replaces every
 * remaining `require()` with a shim that throws at runtime ("Dynamic
 * require ... is not supported") — a known esbuild limitation, not
 * something `external` works around (it still goes through the same
 * broken shim). A CJS bundle keeps real `require()` calls, which Node
 * resolves builtins through natively regardless of format. The adapters
 * load it via a dynamic `import()` of the `.cjs` file, which Node ESM
 * supports directly (named exports synthesized from the CJS `module.exports`
 * shape) — so the calling code doesn't need to know or care that the
 * bundle itself isn't ESM.
 *
 * Run: node scripts/bundle-vendor.mjs (via the "build" script; wired into
 * prepublishOnly so `npm publish` always ships a fresh vendor/).
 */
import { build, analyzeMetafile } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "vendor");
mkdirSync(outdir, { recursive: true });
const verbose = process.argv.includes("--analyze");

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: true,
  legalComments: "none",
  outExtension: { ".js": ".cjs" },
  metafile: true,
};

const ioredisResult = await build({
  ...shared,
  entryPoints: [{ in: "ioredis", out: "ioredis" }],
  outdir,
  // ioredis has no native/optional deps — bundle everything.
});

const mongodbResult = await build({
  ...shared,
  entryPoints: [{ in: "mongodb", out: "mongodb" }],
  outdir,
  // Optional peer deps the driver require()s dynamically and handles the
  // absence of on its own — never bundled, never expected to be present.
  external: [
    "socks",
    "snappy",
    "kerberos",
    "gcp-metadata",
    "@mongodb-js/zstd",
    "mongodb-client-encryption",
    "@aws-sdk/credential-providers",
  ],
});

for (const [name, result] of [
  ["ioredis", ioredisResult],
  ["mongodb", mongodbResult],
]) {
  const size = statSync(join(outdir, `${name}.cjs`)).size;
  console.log(`vendor/${name}.cjs: ${(size / 1024).toFixed(1)} KB`);
  if (verbose) {
    console.log(await analyzeMetafile(result.metafile));
  }
}
