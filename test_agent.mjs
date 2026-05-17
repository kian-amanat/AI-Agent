// test_agent.mjs
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const WORKSPACE = "backend";

async function run(cmd, { cwd = WORKSPACE, label } = {}) {
  const title = label ?? cmd;
  console.log(`\n🧪 RUN: ${title}\n> ${cmd}\n`);

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      env: process.env,
      maxBuffer: 1024 * 1024 * 50, // 50MB برای لاگ‌های طولانی
    });

    if (stdout?.trim()) console.log(stdout);
    if (stderr?.trim()) console.error(stderr);

    console.log(`✅ OK: ${title}`);
    return { ok: true, stdout, stderr };
  } catch (err) {
    const stdout = err?.stdout ?? "";
    const stderr = err?.stderr ?? "";
    const code = err?.code ?? 1;

    if (stdout?.trim()) console.log(stdout);
    if (stderr?.trim()) console.error(stderr);

    console.error(`❌ FAIL: ${title} (exit code: ${code})`);
    return { ok: false, stdout, stderr, code };
  }
}

async function main() {
  console.log("⚙️ Test Agent starting...");
  console.log(`📁 Workspace: ${WORKSPACE}`);

  // 1) نصب وابستگی‌ها
  // اگر CI-friendly می‌خوای و package-lock داری: npm ci
  const install = await run("npm install", { label: "Install dependencies" });
  if (!install.ok) process.exit(install.code ?? 1);

  // 2) چک تایپ‌اسکریپت
  const tsc = await run("npx tsc --noEmit", { label: "Typecheck (tsc --noEmit)" });
  if (!tsc.ok) process.exit(tsc.code ?? 1);

  // 3) تست‌ها
  const test = await run("npm test", { label: "Run tests" });
  if (!test.ok) process.exit(test.code ?? 1);

  console.log("\n🎉 All good: install + typecheck + tests passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Unexpected error in test_agent:", e);
  process.exit(1);
});
