/**
 * Bundles the CLI into a single self-contained CommonJS file (dist/cli.cjs),
 * a prerequisite for building the standalone binary (Node SEA).
 */
import * as esbuild from "esbuild";

// Optional mongodb dependencies (loaded via require inside try/catch blocks).
// Not installed here → externalized so they don't break the bundle; mongodb
// handles their absence gracefully at runtime.
const optionalMongo = [
  "@aws-sdk/credential-providers",
  "@mongodb-js/zstd",
  "gcp-metadata",
  "kerberos",
  "mongodb-client-encryption",
  "snappy",
  "socks",
  "aws4",
];

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/cli.cjs",
  external: optionalMongo,
  loader: { ".json": "json" },
  logLevel: "info",
});

console.log("✅ Bundle écrit : dist/cli.cjs");
