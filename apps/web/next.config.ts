import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const config: NextConfig = {
  transpilePackages: ["@serv/pipeline", "@serv/config"],
  // Native and binary-path packages must load from node_modules at runtime, not be bundled.
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static", "ffprobe-static", "@deepgram/sdk", "@google/genai", "ws", "opus-decoder"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  env: { SERV_REPO_ROOT: repoRoot },
};

export default config;
