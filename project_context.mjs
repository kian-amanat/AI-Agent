import fs from "fs";
import path from "path";

export function walkDir(dir, base = dir, fileList = []) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      walkDir(full, base, fileList);
    } else {
      fileList.push(path.relative(base, full));
    }
  }

  return fileList;
}

export function readFileSafe(file) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

export function extractDependencies(pkg) {
  return {
    dependencies: Object.keys(pkg.dependencies || {}),
    devDependencies: Object.keys(pkg.devDependencies || {}),
  };
}

export function buildProjectContext(projectDir) {
  const pkgPath = path.join(projectDir, "package.json");
  const tsconfigPath = path.join(projectDir, "tsconfig.json");

  let pkg = {};
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  }

  const deps = extractDependencies(pkg);

  const structure = walkDir(projectDir);

  const schemaFiles = structure.filter(
    (f) => f.includes("schema") || f.includes("db")
  );

  let schemaContent = "";

  for (const file of schemaFiles) {
    const abs = path.join(projectDir, file);
    const content = readFileSafe(abs);

    if (content.length < 8000) {
      schemaContent += `\n--- ${file} ---\n${content}\n`;
    }
  }

  return `
PROJECT STRUCTURE
${structure.join("\n")}

DEPENDENCIES
${deps.dependencies.join(", ")}

DEV DEPENDENCIES
${deps.devDependencies.join(", ")}

DATABASE FILES
${schemaContent}
`;
}
