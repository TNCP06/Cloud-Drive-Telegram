import type { NextConfig } from "next";

// DEMO_MODE=1 builds the UI-only demo (Vercel): no Postgres, no bot, no streamer —
// see lib/db.ts. Everything below only *removes* Docker-specific config in that build,
// so the production image is byte-for-byte unaffected.
const demo = process.env.DEMO_MODE === "1";

const nextConfig: NextConfig = {
  // Lean Docker image: bundles only the files the server needs (.next/standalone).
  // Vercel does its own bundling, so the demo build skips it.
  ...(demo ? {} : { output: "standalone" as const }),

  // PGlite ships a WASM build of Postgres that it loads from disk at runtime, so it must
  // never be bundled. Kept unconditional: the demo's `import()` in lib/db.ts is dead code
  // in the Docker build, but webpack still walks it, and bundling it there would break a
  // build that has nothing to do with the demo.
  serverExternalPackages: ["@electric-sql/pglite"],

  // Vercel only ships files it can trace; the .wasm/.data blobs are opened by path.
  ...(demo
    ? {
        outputFileTracingIncludes: {
          "/**": ["./node_modules/@electric-sql/pglite/dist/*.{wasm,data}"],
        },
      }
    : {}),
};

export default nextConfig;
