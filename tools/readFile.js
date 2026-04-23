import fs from "fs/promises";
import path from "path";

const WORKSPACE = "workspace";

export async function readFile({ path: filePath }) {
  try {

    const fullPath = path.join(WORKSPACE, filePath);
    const content = await fs.readFile(fullPath, "utf-8");

    return {
      success: true,
      content
    };

  } catch (err) {

    return {
      success: false,
      error: err.message
    };
  }
}
