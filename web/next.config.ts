import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean Docker image: bundles only the files the server needs (.next/standalone).
  output: "standalone",
};

export default nextConfig;
