import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
]);

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(full, out);
    } else {
      out.push(full);
    }
  }

  return out;
}

export async function grepCode({
  query,
  maxResults = 20,
}) {
  try {
    const files = await walk(ROOT);

    const results = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(
          file,
          "utf8"
        );

        const lines = content.split("\n");

        lines.forEach((line, index) => {
          if (
            line
              .toLowerCase()
              .includes(query.toLowerCase())
          ) {
            results.push({
              file: path.relative(ROOT, file),
              line: index + 1,
              content: line.trim(),
            });
          }
        });
      } catch {}
    }

    return {
      success: true,
      results: results.slice(0, maxResults),
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}