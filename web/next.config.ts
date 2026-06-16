import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean Docker image: bundles only the files the server needs (.next/standalone).
  output: "standalone",
  // Upload chunks are ~16 MB; raise the middleware body limit so they aren't truncated.
  middlewareClientMaxBodySize: "20mb",
};

export default nextConfig;
