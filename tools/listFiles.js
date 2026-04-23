// tools/list_files.js
import fs from "fs/promises";
import path from "path";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./workspace_utils.js";

export async function listFiles({ dir, __json_error__ }) {
  try {
    if (__json_error__) {
      return {
        success: false,
        error: `Invalid JSON arguments for list_files: ${String(__json_error__).slice(0, 200)}...`,
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    // اگر dir خالی بود، یعنی root workspace
    let baseDir = WORKSPACE_ROOT;
    let baseRel = "";
    if (dir && dir.trim() !== "") {
      const { safeRelPath, fullPath } = resolveWorkspacePath(dir);
      baseDir = fullPath;
      baseRel = safeRelPath;
    }

    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const files = entries.map((entry) => {
      const rel = baseRel
        ? path.join(baseRel, entry.name)
        : entry.name;
      return {
        name: entry.name,
        path: rel,         // نسبی به workspace
        is_dir: entry.isDirectory(),
      };
    });

    return { success: true, files, stdout: "", stderr: "" };
  } catch (err) {
    return { success: false, error: err.message, files: [], stdout: "", stderr: "" };
  }
}
