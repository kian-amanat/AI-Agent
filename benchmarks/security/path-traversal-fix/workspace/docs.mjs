import fs from "fs";
import path from "path";

const DOCS_DIR = path.join(process.cwd(), "docs");

/** Serve a file from docs/. Returns its contents, or null when absent. */
export function readDoc(name) {
  const target = path.join(DOCS_DIR, name);
  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}
