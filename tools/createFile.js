// tools/create_file.js
import fs from "fs/promises";
import path from "path";
import { resolveWorkspacePath } from "./workspace_utils.js";

export async function createFile({ path: relPath, content_base64, __json_error__ } = {}) {
  try {
    // اگر Agent تشخیص داده که JSON خراب بوده
    if (__json_error__) {
      return {
        success: false,
        error: `Invalid JSON arguments for create_file: ${String(__json_error__).slice(0, 200)}...`,
        stdout: "",
        stderr: "",
      };
    }

    // validation خود path
    if (!relPath || typeof relPath !== "string") {
      return {
        success: false,
        error:
          "create_file: 'path' is required and must be a non-empty string relative to the workspace root, e.g. 'login-app/index.html'.",
        stdout: "",
        stderr: "",
      };
    }

    if (!content_base64 || typeof content_base64 !== "string") {
      return {
        success: false,
        error: "create_file: 'content_base64' is required and must be a string.",
        stdout: "",
        stderr: "",
      };
    }

    const { safeRelPath, fullPath } = resolveWorkspacePath(relPath);

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    const buffer = Buffer.from(content_base64, "base64");
    const content = buffer.toString("utf-8");

    await fs.writeFile(fullPath, content, "utf-8");

    return { success: true, path: safeRelPath, stdout: "", stderr: "" };
  } catch (err) {
    return { success: false, error: err.message, stdout: "", stderr: "" };
  }
}
