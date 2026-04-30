// tools/list_backend_files.js
import fs from "fs/promises";
import path from "path";

// ریشه‌ی پروژه (همون جایی که backend_agent.js رو اجرا می‌کنی)
const PROJECT_ROOT = process.cwd();

/**
 * به صورت بازگشتی همه‌ی فایل‌ها و دایرکتوری‌ها را لیست می‌کند.
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

    // چک کن که دایرکتوری وجود دارد
    const stat = await fs.stat(baseDir);
    if (!stat.isDirectory()) {
      return {
        success: false,
        error: `Path is not a directory: ${baseRel || "."}`,
        files: [],
        stdout: "",
        stderr: "",
      };
    }

    const files = [];

    // تابع بازگشتی برای پیمایش
    async function walk(currentAbsDir, currentRelDir) {
      const entries = await fs.readdir(currentAbsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }

        const entryAbs = path.join(currentAbsDir, entry.name);
        const entryRel = currentRelDir
          ? path.join(currentRelDir, entry.name)
          : entry.name;

        files.push({
          name: entry.name,
          path: entryRel.replace(/\\/g, "/"),
          is_dir: entry.isDirectory(),
        });

        if (entry.isDirectory()) {
          await walk(entryAbs, entryRel);
        }
      }
    }

    await walk(baseDir, baseRel);

    return {
      success: true,
      files,
      stdout: "",
      stderr: "",
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err),
      files: [],
      stdout: "",
      stderr: "",
    };
  }
}
