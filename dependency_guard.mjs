import fs from "fs";
import path from "path";

const bannedDeps = {
  bcryptjs: "bcrypt",
  tap: "vitest",
  "@fastify/bcrypt": "bcrypt",
};

export function guardDependencies(projectDir) {
  const pkgPath = path.join(projectDir, "package.json");

  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  let changed = false;

  function fix(deps) {
    if (!deps) return;

    for (const bad in bannedDeps) {
      if (deps[bad]) {
        delete deps[bad];
        deps[bannedDeps[bad]] = "latest";
        changed = true;

        console.log(`🔧 Replacing ${bad} -> ${bannedDeps[bad]}`);
      }
    }
  }

  fix(pkg.dependencies);
  fix(pkg.devDependencies);

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
}
