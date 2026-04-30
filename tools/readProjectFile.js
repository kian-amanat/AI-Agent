import fs from "fs/promises";

export async function readProjectFile({ path }) {
  try {

    const content = await fs.readFile(path, "utf-8");

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
