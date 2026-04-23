import fs from "fs";
import path from "path";

const workspace = "./workspace";

export function writeFile(filePath, content) {
  const fullPath = path.join(workspace, filePath);

  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(fullPath, content);
}

export function readFile(filePath) {
  const fullPath = path.join(workspace, filePath);
  return fs.readFileSync(fullPath, "utf8");
}
