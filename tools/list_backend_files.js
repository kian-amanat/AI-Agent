// tools/list_backend_files.js
import fs from "fs/promises";
import path from "path";

// ریشه‌ی پروژه (همون جایی که backend_agent.js رو اجرا می‌کنی)
const PROJECT_ROOT = process.cwd();

/**
 * لیست کردن فایل‌ها برای backend.
 *
 * ورودی:
 *   - dir: مسیر نسبی نسبت به ریشه‌ی پروژه (مثلاً "backend" یا "backend/routes")
 *
 * خروجی:
 *   {
 *     success: boolean,
 *     files: [ { name, path, is_dir }, ... ],
 *     error?: string,
 *     stdout: string,
 *     stderr: string
 *   }
 */
export async function listBackendFiles({ dir, __json_error__ } = {}) {
  try {
    if (__json_error__) {
      return {
        success: false,
        error: `Invalid JSON arguments for listBackendFiles: ${String(__json_error__).slice(0, 200)}...`,
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    // اگر dir خالی بود، یعنی root پروژه
    let baseDir = PROJECT_ROOT;
    let baseRel = "";
    if (dir && dir.trim() !== "") {
      // dir رو نسبی به ریشه‌ی پروژه در نظر می‌گیریم (بدون "workspace")
      baseRel = dir;
      baseDir = path.join(PROJECT_ROOT, dir);
    }

    const entries = await fs.readdir(baseDir, { withFileTypes: true });

    const files = entries.map((entry) => {
      const rel = baseRel
        ? path.join(baseRel, entry.name)
        : entry.name;

      return {
        name: entry.name,
        path: rel,         // همیشه نسبت به ریشه‌ی پروژه
        is_dir: entry.isDirectory(),
      };
    });

    return {
      success: true,
      files,
      stdout: "",
      stderr: "",
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      files: [],
      stdout: "",
      stderr: "",
    };
  }
}
