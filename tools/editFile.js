// tools/edit_file.js
import fs from "fs/promises";
import path from "path";

export async function editFile({ path: filePath, content_base64, __json_error__ }) {
  try {
    if (__json_error__) {
      return {
        success: false,
        error: `Invalid JSON arguments for edit_file: ${String(__json_error__).slice(0, 200)}...`
      };
    }

    if (!filePath || typeof filePath !== "string") {
      return { success: false, error: "edit_file: 'path' is required and must be a string." };
    }
    if (!content_base64 || typeof content_base64 !== "string") {
      return { success: false, error: "edit_file: 'content_base64' is required and must be a string." };
    }

    const fullPath = path.resolve(process.cwd(), filePath);

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    const buffer = Buffer.from(content_base64, "base64");
    const content = buffer.toString("utf-8");

    await fs.writeFile(fullPath, content, "utf-8");

    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
