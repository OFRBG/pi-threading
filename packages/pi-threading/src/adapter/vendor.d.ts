// Ambient shapes for the bundled vendor files scripts/bundle-vendor.mjs
// produces at vendor/*.mjs (gitignored — generated, not checked in). These
// let tsc resolve the relative dynamic imports in redis.ts/mongo.ts without
// the actual bundle needing to exist at typecheck time; wildcard module
// declarations match by trailing path regardless of how many "../" segments
// precede it.

declare module "*/vendor/ioredis.cjs" {
  import type Redis from "ioredis";
  const RedisCtor: typeof Redis;
  export default RedisCtor;
}

declare module "*/vendor/mongodb.cjs" {
  export { MongoClient } from "mongodb";
}
