import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the release artifact.
  //
  // A normal build needs the whole 730 MB node_modules tree to run, which made
  // the release tarball 602 MB — big enough that "download and install" stops
  // being a reasonable thing to ask of a user. Standalone traces the modules
  // the server actually reaches and emits a self-contained directory with just
  // those, cutting it by well over an order of magnitude.
  //
  // `kodo ui start` runs the traced server from the artifact; developers
  // running `npm run dev` are unaffected.
  output: "standalone",

  images: {
    qualities: [75, 100],
  },
  turbopack: {
    // Pin the workspace root explicitly. Without this, Next.js auto-detects
    // the root by walking UP for the nearest lockfile — and the repo root
    // (ai-sandbox/) has its own package-lock.json one level up from this
    // project. That misdetection made Turbopack watch the ENTIRE outer repo
    // (~100k files: both projects' node_modules, .git, the backend's SQLite
    // WAL files that change on every request, growing undo-history snapshots)
    // instead of just this app's ~54 files — a watch-storm that pins the CPU
    // and floods disk I/O badly enough to make the whole machine unresponsive.
    root: __dirname,
  },
};

export default nextConfig;
