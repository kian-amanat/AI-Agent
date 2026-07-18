/**
 * config/env.mjs
 * Loads .env into process.env BEFORE any other module reads it.
 * Must be the FIRST import in server.mjs (ESM evaluates imports in order).
 *
 * Search order: backend1/.env, then the repo root ../.env.
 * Existing process.env values always win — never overridden.
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const candidate of [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
]) {
  try {
    // Node 20.12+ — parses the file and fills process.env (no overrides).
    process.loadEnvFile(candidate);
    console.log(`[env] loaded ${candidate}`);
  } catch { /* file missing or unreadable — fine */ }
}
