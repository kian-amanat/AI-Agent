// backend_agent.js (ESM) - Backend Login Agent

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import OpenAI from "openai";

import { runBackendCommand } from "./tools/run_backend_command.js";
import { runBackendTests } from "./tools/runBackendTests.js";
import { readFile } from "./tools/readFile.js";
import { editFile } from "./tools/editFile.js";
import { listBackendFiles } from "./tools/list_backend_files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const BACKEND_ROOT = path.join(process.cwd(), "backend");
const HARD_MAX_STEPS = Number(process.env.BACKEND_HARD_MAX_STEPS || 40);

// برای runBackendTests که cwd نسبی می‌گیرد
const BACKEND_CWD_REL = "backend";

const SYSTEM_PROMPT = `
تو یک agent backend هستی که باید:

- یک API لاگین و رفرش توکن با Node.js + Express + SQLite بسازی،
- CORS را برای فرانت‌اند روی http://localhost:5173 تنظیم کنی،
- تست‌های خودکار با Jest + Supertest بسازی که coverage خوبی داشته باشند،
- کل فرآیند را به شکل incremental و امن پیش ببری.

نکات بسیار مهم:

1) اگر خروجی تست‌ها نشان بدهد که:
   - "Error: no test specified"
   - یا "No tests found"
   ابتدا باید focus کنی روی راه‌اندازی زیرساخت تست:
   - افزودن script تست در package.json (مثلاً "test": "jest"),
   - نصب jest و supertest،
   - ساخت jest.config.js مناسب ESM،
   - ساخت حداقل یک تست ساده (smoke یا health) که پاس شود.

2) ساختار فایل‌ها:
   - server.js باید یک app از Express بسازد و آن را export default کند،
     و فقط در صورت NODE_ENV !== "test" روی یک PORT گوش دهد.
   - تست‌ها در پوشه __tests__/ قرار می‌گیرند و با Supertest، API را صدا می‌زنند.

3) هدفت این است که با هر مرحله:
   - اول تست‌ها را سبز نگه داری،
   - بعد تست جدید اضافه کنی،
   - بعد کد را طوری تغییر دهی که تست جدید پاس شود.

4) خروجی planner باید فقط JSON مطابق ساختاری که در prompt مخصوص planner توضیح داده شده است باشد.

5) در ویرایش فایل‌ها، باید کل فایل را به صورت self-contained و صحیح بازنویسی کنی (نه patch تکه‌ای).

`.trim();

const openai = new OpenAI({
  apiKey:
    process.env.OPENAI_API_KEY ||
    "sk-kwT53wRAXygEY2vdQSrO4HA0tNYTtXuQrBH2QeVbCuKu8oDy",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

// ----------- summarizeBackendFiles -----------

async function summarizeBackendFiles() {
  const filesResponse = await listBackendFiles({ dir: "backend" });

  console.log("DEBUG: listFiles response:", filesResponse);

  if (!filesResponse || !filesResponse.success) {
    console.warn("⚠️ listFiles failed or returned success=false for backend/");
    return "<failed to list backend files>";
  }

  const allEntries = Array.isArray(filesResponse.files)
    ? filesResponse.files
    : [];

  const files = allEntries.filter((f) => !f.is_dir);

  if (files.length === 0) {
    console.warn("⚠️ هشدار: فایل قابل فهرست‌بندی در backend/ پیدا نشد.");
    return "<No backend files to summarize>";
  }

  const summaries = files.map((file) => `File: ${file.path}`);
  return summaries.join("\n");
}

// ----------- callPlanner -----------

async function callPlanner({ testStatus, filesSummary, dbModelSummary }) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `
تو یک planner برای یک agent بک‌اند هستی.
خروجی تو باید دقیقا و فقط یک JSON معتبر باشد.
هیچ متن اضافی، هیچ توضیح، هیچ بلاک مارک‌داون (\`\`\`) نباید برگردانی.

ساختار JSON خروجی:
{
  "ready_for_user_review": boolean,
  "changes": [
    {
      "target_files": string[],
      "reason": string,
      "actions": string[]
    }
  ]
}

اگر در testStatus دیدی پیغام‌هایی از این جنس وجود دارد:
- "Error: no test specified"
- "No tests found"
یا واضح است که هیچ تستی اجرا نشده،
باید در changes فایل‌های مرتبط با راه‌اندازی تست (مثل backend/package.json, backend/jest.config.js, backend/__tests__/...) را هدف بگیری
و دلیل را واضحاً حول "راه‌اندازی زیرساخت تست" بنویسی.
`.trim(),
      },
      {
        role: "user",
        content: `
وضعیت تست‌ها:
${testStatus}

خلاصه فایل‌های بک‌اند:
${filesSummary}

خلاصه مدل دیتابیس (اگر هست):
${dbModelSummary}

بر اساس این اطلاعات، برنامه‌ریزی کن چه تغییراتی لازم است.
خروجی را فقط و فقط به صورت یک آبجکت JSON مطابق ساختار خواسته شده برگردان.
هیچ توضیح دیگری ننویس.
`.trim(),
      },
    ],
    temperature: 0,
  });

  const text = response.choices[0].message.content || "";
  console.log("DEBUG: Planner raw response:", text);

  try {
    return JSON.parse(text);
  } catch (e1) {
    console.warn("⚠️ Planner raw text is not pure JSON:", e1.message);
    throw e1;
  }
}

// ----------- ensureBackendInitialized -----------

function ensureBackendInitialized() {
  if (!fs.existsSync(BACKEND_ROOT)) {
    console.log("📂 backend folder not found. Creating...");
    fs.mkdirSync(BACKEND_ROOT, { recursive: true });
  }

  const packageJsonPath = path.join(BACKEND_ROOT, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.log("📦 package.json not found. Initializing npm project...");
    execSync("npm init -y", { cwd: BACKEND_ROOT, stdio: "inherit" });
  } else {
    console.log("✅ Backend already initialized. Skipping npm init.");
  }

  // Ensure package.json has required fields
  const pkgRaw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(pkgRaw);

  pkg.type = pkg.type || "module";
  pkg.scripts = pkg.scripts || {};
  if (
    !pkg.scripts.test ||
    pkg.scripts.test === 'echo "Error: no test specified" && exit 1'
  ) {
    pkg.scripts.test = "jest";
  }

  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), "utf8");

  // Install dependencies if not installed
  const nodeModulesPath = path.join(BACKEND_ROOT, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log(
      "⬇️ Installing backend dependencies (express, sqlite3, cors, jest, supertest)..."
    );
    execSync("npm install express sqlite3 cors", {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
    });
    execSync("npm install -D jest supertest", {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
    });
  } else {
    console.log(
      "✅ node_modules exists. Skipping npm install (you can delete node_modules to force reinstall)."
    );
  }

  const serverJsPath = path.join(BACKEND_ROOT, "server.js");
  if (!fs.existsSync(serverJsPath)) {
    console.log("📄 Creating minimal backend/server.js...");
    const serverCode = `import express from "express";
import cors from "cors";

const app = express();

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// TODO: Implement /api/login and /api/refresh endpoints.

const PORT = process.env.PORT || 4000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log("Backend server listening on port", PORT);
  });
}

export default app;
`;
    fs.writeFileSync(serverJsPath, serverCode, "utf8");
    console.log("✅ Created backend/server.js");
  }
}

// ----------- ensureTestInfrastructure -----------

function ensureTestInfrastructure() {
  const jestConfigPath = path.join(BACKEND_ROOT, "jest.config.js");
  if (!fs.existsSync(jestConfigPath)) {
    console.log("🧪 Creating default jest.config.js...");
    const jestConfig = `export default {
  testEnvironment: "node",
  transform: {}
};
`;
    fs.writeFileSync(jestConfigPath, jestConfig, "utf8");
  }

  const testsDir = path.join(BACKEND_ROOT, "__tests__");
  if (!fs.existsSync(testsDir)) {
    console.log("🧪 Creating __tests__ folder...");
    fs.mkdirSync(testsDir);
  }

  // اگر هیچ فایل تستی وجود ندارد، smoke test بساز
  const testFiles = fs
    .readdirSync(testsDir)
    .filter(
      (name) => name.endsWith(".test.js") || name.endsWith(".spec.js")
    );

  if (testFiles.length === 0) {
    console.log(
      "🧪 No test files found in __tests__. Creating smoke.test.js..."
    );
    const smokeTestPath = path.join(testsDir, "smoke.test.js");
    const smokeTestCode = `describe("smoke test", () => {
  it("should pass", () => {
    expect(true).toBe(true);
  });
});
`;
    fs.writeFileSync(smokeTestPath, smokeTestCode, "utf8");
  }
}

// ----------- main loop -----------

export async function runBackendAgent() {
  console.log("🤖 Starting backend agent (ESM)...");
  console.log("Backend root:", BACKEND_ROOT);

  ensureBackendInitialized();
  ensureTestInfrastructure();

  let step = 0;

  while (step < HARD_MAX_STEPS) {
    step++;
    console.log(
      `\n================ Backend Agent Step ${step} ================`
    );

    console.log("🧪 Running backend tests...");
    let testResult;
    try {
      // اینجا از runBackendTests استفاده می‌کنیم که خودش run_backend_command را صدا می‌زند
      testResult = await runBackendTests({
        cmd: "npm test",
        // run_backend_command cwd نسبی می‌گیرد؛ اینجا "backend" می‌دهیم
        cwd: BACKEND_CWD_REL,
      });
    } catch (e) {
      console.error("❌ runBackendTests failed:", e);
      testResult = { success: false, stdout: "", stderr: String(e) };
    }

    console.log(
      "DEBUG: npm test stdout:\n",
      testResult.stdout ? testResult.stdout : "<empty stdout>"
    );
    console.log(
      "DEBUG: npm test stderr:\n",
      testResult.stderr ? testResult.stderr : "<empty stderr>"
    );

    const lastTestStatus = `
success: ${testResult.success}
stdout:
${testResult.stdout || ""}
stderr:
${testResult.stderr || ""}
`;

    if (testResult.success) {
      console.log("✅ Tests currently passing.");
    } else {
      console.log("⚠️ Tests failing (expected until fix).");
    }

    console.log("📂 Summarizing backend files...");
    let filesSummary = "";
    try {
      filesSummary = await summarizeBackendFiles();
    } catch (e) {
      console.error("❌ Failed to summarize backend files:", e);
      filesSummary = "<failed to summarize files>";
    }

    console.log("🧠 Calling backend planner...");
    let plan;
    try {
      plan = await callPlanner({
        testStatus: lastTestStatus,
        filesSummary,
        dbModelSummary:
          "users + sessions tables in SQLite as described in the system prompt.",
      });
    } catch (e) {
      console.error("❌ Planner failed:", e);
      break;
    }

    console.log("📋 Planner plan:", JSON.stringify(plan, null, 2));

    if (plan.ready_for_user_review && testResult.success) {
      console.log(
        "🎉 Planner marked ready_for_user_review AND tests passing. Stopping agent."
      );
      break;
    }

    if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
      console.log(
        "⚠️ Planner did not return any changes. Nothing to edit this step."
      );
      if (testResult.success) {
        console.log("✅ Tests passing and no changes needed. Stopping.");
        break;
      } else {
        console.log(
          "⚠️ Tests failing but no changes suggested. Stopping to avoid loop."
        );
        break;
      }
    }

    for (const change of plan.changes) {
      const targetFiles = change.target_files || [];
      if (!Array.isArray(targetFiles) || targetFiles.length === 0) continue;

      for (const relPath of targetFiles) {
        // اگر planner مسیرها را با "backend/..." برگرداند، آن را normalize کن
        const cleanedRelPath = relPath.startsWith("backend/")
          ? relPath.replace(/^backend\//, "")
          : relPath;

        const absPath = path.join(BACKEND_ROOT, cleanedRelPath);
        console.log(`✏️ Editing file: ${cleanedRelPath}`);

        let currentContent = "";
        if (fs.existsSync(absPath)) {
          try {
            currentContent = await readFile({ filePath: absPath });
          } catch (e) {
            console.warn(`⚠️ Failed to read ${cleanedRelPath}:`, e);
            currentContent = "";
          }
        }

        const fileEditPrompt = `
تو در حال ویرایش یک فایل backend در Node + Express + SQLite هستی.

نام فایل (نسبت به پوشه backend): ${cleanedRelPath}

محتوای فعلی:
----------------
${currentContent}
----------------

تغییرات برنامه‌ریزی شده:
علت: ${change.reason || "N/A"}
اقدامات:
- ${(change.actions || []).join("\n- ")}

وضعیت تست‌ها:
${lastTestStatus}

اهداف سطح بالا:
- ساخت API لاگین و رفرش توکن با SQLite،
- تنظیم CORS،
- نوشتن تست‌های Jest + Supertest.

لطفاً کل محتوای جدید فایل را به صورت کامل و قابل اجرا برگردان.
هیچ توضیح متنی، هیچ توضیح خارج از کد ننویس. فقط کد فایل.
`;

        let newContent;
        try {
          const resp = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: fileEditPrompt },
            ],
            temperature: 0.2,
          });
          newContent = resp.choices[0].message.content || "";
        } catch (e) {
          console.error("❌ File edit model call failed:", e);
          continue;
        }

        try {
          await editFile({
            filePath: absPath,
            newContent,
          });
          console.log(`✅ Updated ${cleanedRelPath}`);
        } catch (e) {
          console.error(`❌ Failed to write ${cleanedRelPath}:`, e);
        }
      }
    }

    await sleep(800);
  }

  if (step >= HARD_MAX_STEPS) {
    console.warn(
      `⚠️ Reached HARD_MAX_STEPS = ${HARD_MAX_STEPS} without stopping.`
    );
  }

  console.log("🏁 Backend agent finished.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackendAgent().catch((err) => {
    console.error("❌ Backend agent crashed:", err);
    process.exit(1);
  });
}
