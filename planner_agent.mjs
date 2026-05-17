// planner_agent.mjs (ESM) - High-level project planner using OpenAI

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- Config ----------
const PROJECT_ROOT = process.cwd();
const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
const BACKEND_CWD_REL = path.relative(PROJECT_ROOT, BACKEND_ROOT) || "backend";

const PLANNER_GOAL =
  process.env.PLANNER_GOAL ||
  "Design a complete backend architecture and implementation plan for a Fastify + TypeScript + Drizzle + SQLite + Auth project compatible with frontend API/api2.ts";

const FRONTEND_AUTH_CONTRACT_PATH = path.join(
  PROJECT_ROOT,
  "API",
  "api2.ts"
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

// --------- System prompt ----------
const PLANNER_SYSTEM_PROMPT = `
تو یک "Project Planner" ارشد نرم‌افزار هستی که خروجی‌ات فقط یک JSON plan دقیق است.
این plan برای یک Agent دیگر استفاده می‌شود تا بر اساس آن کد بنویسد و فایل‌ها را بسازد.

الزامات مهم:
- خروجی فقط و فقط یک JSON معتبر باشد (بدون توضیح اضافی، بدون مارک‌داون، بدون \`\`\`).
- هدف: طراحی یک "Project Plan" کامل، شامل:
  - tech_stack: مشخصات تکنولوژی (runtime, language, framework, orm, db, testing, tooling و ...)
  - phases: فازهایی که باید طی شوند (bootstrap, domain modeling, auth, tests, hardening و ...)
  - steps: در هر فاز چند step؛ هر step شامل:
    - id: شناسه‌ی یکتا (string کوتاه شبیه slug)
    - description: توضیح فارسی/انگلیسی کوتاه ولی دقیق
    - files: لیست فایل‌ها / فولدرهایی که ایجاد یا تغییر می‌شوند (path نسبی)
    - dependencies: لیست id steps دیگر که این step به آن‌ها وابسته است
    - priority: "high" | "medium" | "low"
  - files: لیست توضیح برای هر فایل مهم:
    - path
    - kind: "config" | "app" | "db" | "module" | "test" | "script"
    - purpose: توضیح کوتاه
    - notes: نکات طراحی/معماری، constraints مهم

قوانین:
- خروجی JSON باید ساختار زیر را داشته باشد:

{
  "name": string,
  "ready_for_user_review": boolean,
  "goal": string,
  "tech_stack": {
    "runtime": string,
    "language": string,
    "framework": string,
    "orm": string,
    "db": string,
    "testing": string,
    "tooling": string
  },
  "phases": [
    {
      "id": string,
      "title": string,
      "description": string,
      "steps": [
        {
          "id": string,
          "description": string,
          "files": string[],
          "dependencies": string[],
          "priority": "high" | "medium" | "low"
        }
      ]
    }
  ],
  "files": [
    {
      "path": string,
      "kind": "config" | "app" | "db" | "module" | "test" | "script",
      "purpose": string,
      "notes": string
    }
  ],
  "notes": string
}

- حتماً به جای "express" باید از "Fastify" استفاده شود.
- backend باید ESM باشد (NodeNext module).
- تمرکز اصلی روی backend است (پوشش login/register/me + forgot-password اسکلت).
- اگر فایل API/api2.ts موجود است، plan باید با endpointها و قرارداد آن align باشد.
- اگر backend/ خالی یا تقریبا خالی است، در phases اولیه ابزار لازم برای bootstrap پروژه (package.json, tsconfig.json, drizzle.config.ts, jest.config.cjs, src/app.ts, src/config.ts, src/db/schema.ts و ...) را در نظر بگیر.
`.trim();

// --------- Utility: safe JSON parse ----------
function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// --------- Summarize backend structure ----------
async function summarizeBackend() {
  try {
    const res = await listBackendFiles({ dir: BACKEND_CWD_REL });
    if (!res || !res.success) {
      return "<failed to list backend/>";
    }

    const entries = Array.isArray(res.files) ? res.files : [];
    if (!entries.length) {
      return "<backend dir is empty>";
    }

    const lines = entries.map((e) => {
      const kind = e.is_dir ? "DIR " : "FILE";
      return `${kind}: ${e.path}`;
    });

    return lines.join("\n");
  } catch (e) {
    return `<error while listing backend: ${String(e)}>`;
  }
}

// --------- Read frontend contract snippet (API/api2.ts) ----------
async function readFrontendContractSnippet() {
  try {
    if (!fs.existsSync(FRONTEND_AUTH_CONTRACT_PATH)) {
      return "<API/api2.ts not found>";
    }

    const res = await readProjectFile({ path: FRONTEND_AUTH_CONTRACT_PATH });
    const content =
      typeof res === "string"
        ? res
        : typeof res?.content === "string"
        ? res.content
        : "";

    if (!content) return "<API/api2.ts empty or unreadable>";

    return content.slice(0, 2000);
  } catch (e) {
    return `<error reading API/api2.ts: ${String(e)}>`;
  }
}

// --------- Core planner call ----------
async function runPlanner() {
  console.log("🧠 Planner started...");
  console.log("Project root:", PROJECT_ROOT);
  console.log("Backend root:", BACKEND_ROOT);
  console.log("Goal:", PLANNER_GOAL);

  const backendSummary = await summarizeBackend();
  const frontendContractSnippet = await readFrontendContractSnippet();

  const userPrompt = `
Goal / درخواست کاربر:
${PLANNER_GOAL}

خلاصه وضعیت فعلی backend/:
${backendSummary}

Snippet از API/api2.ts (اگر وجود دارد):
${frontendContractSnippet}

وظیفه:
- یک plan کامل برای پیاده‌سازی backend مطابق goal و قرارداد frontend طراحی کن.
- plan باید شامل phases, steps, files, tech_stack باشد.
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      {
        role: "system",
        content: PLANNER_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    temperature: 0.1,
  });

  const raw = resp.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(raw);

  if (!parsed.ok) {
    console.error("❌ Planner returned non-JSON. Raw:");
    console.error(raw);
    throw parsed.error;
  }

  const plan = parsed.value;

  // خروجی روی stdout (برای استفاده توسط ابزارهای دیگر یا ذخیره در فایل)
  console.log("\n📋 Generated Plan (JSON):\n");
  console.log(JSON.stringify(plan, null, 2));

  // به صورت اختیاری می‌توانیم آن را در فایل ذخیره کنیم
  const outPath = path.join(PROJECT_ROOT, "planner_plan.json");
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf8");
  console.log(`\n💾 Plan saved to: ${outPath}`);
}

// اجرای مستقیم
if (import.meta.url === `file://${process.argv[1]}`) {
  runPlanner().catch((err) => {
    console.error("❌ Planner crashed:", err);
    process.exit(1);
  });
}

export { runPlanner };
