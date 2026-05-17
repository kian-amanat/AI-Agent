// backend_agent.mjs (ESM) - Single-step Backend Agent (Fastify + TS + Drizzle + SQLite + Auth, ESM backend)

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import OpenAI from "openai";

import { runBackendCommand } from "./tools/run_backend_command.js";
import { runBackendTests } from "./tools/runBackendTests.js";
import { readProjectFile as readFile } from "./tools/readProjectFile.js";
import { editFile } from "./tools/editFile.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile as readFrontendFile } from "./tools/readProjectFile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- Configurable paths / goal ----------
const BACKEND_ROOT = path.join(
  process.env.BACKEND_ROOT_PATH || process.cwd(),
  "backend"
);
const BACKEND_CWD_REL = path.relative(process.cwd(), BACKEND_ROOT) || "backend";

const FRONTEND_AUTH_CONTRACT_PATH = path.join(
  process.cwd(),
  "API",
  "api2.ts"
);

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const APP_URL = process.env.BACKEND_APP_URL || "http://localhost:3000";

const CURL_BIN = process.env.CURL_BIN || "curl";

const GOAL = (process.env.BACKEND_GOAL || "frontend").toLowerCase();

// ---------- LLM Setup ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

// ---------- Structure Spec ----------
const REQUIRED_BACKEND_FILES = [
  "package.json",
  "tsconfig.json",
  "drizzle.config.ts",
  "jest.config.cjs",
  "src/app.ts",
  "src/config.ts",
  "src/db/index.ts",
  "src/db/schema.ts",
  "src/modules/common/errors.ts",
  "src/modules/common/security.ts",
  "src/modules/auth/auth.schemas.ts",
  "src/modules/auth/auth.repository.ts",
  "src/modules/auth/auth.service.ts",
  "src/modules/auth/auth.controller.ts",
  "tests/auth.login.test.ts",
  "tests/auth.register.test.ts",
  "tests/auth.me.test.ts",
];

const REQUIRED_BACKEND_DIRS = [
  "src",
  "src/db",
  "src/modules",
  "src/modules/common",
  "src/modules/auth",
  "tests",
];

// ---------- System Prompt (Coder) ----------
const SYSTEM_PROMPT = `
تو یک Agent ارشد بک‌اند هستی که با Node.js + TypeScript + Fastify + Drizzle ORM + SQLite کار می‌کنی.

هدف:
- بر اساس قرارداد فرانت‌اند (فایل API/api2.ts که شامل توابعی مثل login/register/me و ... است)
  یک بک‌اند production-grade بساز.
- استک: Fastify + TypeScript + Zod + Drizzle + SQLite + JWT + bcrypt.
- امنیت:
  - استفاده از bcrypt برای hash رمز عبور.
  - استفاده از JWT برای access token (فعلاً فقط access).
  - اعتبارسنجی request با Zod.
  - استفاده از @fastify/helmet برای security headers.
  - استفاده از @fastify/rate-limit برای rate limiting مخصوصاً روی login.
  - لاگ‌گیری امن (بدون چاپ password/token در لاگ).
- معماری لایه‌ای:
  backend/
  ├── package.json
  ├── tsconfig.json
  ├── drizzle.config.ts
  ├── jest.config.cjs
  ├── src/
  │   ├── app.ts
  │   ├── config.ts
  │   ├── db/
  │   │   ├── index.ts
  │   │   └── schema.ts
  │   └── modules/
  │       ├── common/
  │       │   ├── errors.ts
  │       │   └── security.ts
  │       └── auth/
  │           ├── auth.schemas.ts
  │           ├── auth.repository.ts
  │           ├── auth.service.ts
  │           └── auth.controller.ts
  └── tests/
      ├── auth.login.test.ts
      ├── auth.register.test.ts
      └── auth.me.test.ts

قرارداد با فرانت‌اند (بر اساس API/api2.ts):
- BASE_URL از محیط می‌آید، AUTH_BASE = \`\${BASE_URL}/back/api/auth\`
- endpointها:
  - POST /back/api/auth/login
  - GET  /back/api/auth/me
  - POST /back/api/auth/register
  - POST /back/api/auth/forgot/request   (اسکلت)
  - POST /back/api/auth/forgot/verify    (اسکلت)
  - POST /back/api/auth/forgot/reset     (اسکلت)
- login:
  - body: { email: string, password: string }
  - پاسخ موفق: شامل فیلد token یا access_token برای ذخیره در فرانت‌اند.
- register:
  - body: { email, password, first_name?, last_name?, phone_number? }
  - پاسخ موفق: شامل token/access_token و user.
- me:
  - هدر Authorization: Bearer <token>.
  - پاسخ موفق: اطلاعات یوزر بدون passwordHash.
- forgot/*:
  - فعلاً اسکلت با { success: true } کافی است.

الزامات کیفی:
- جداسازی concerns: db/schema, repository, service, controller, validation.
- error handling مناسب، status code درست، پیام‌های فارسی قابل‌فهم.
- CORS برای ${FRONTEND_ORIGIN} تنظیم شود.
- app.ts باید buildApp را export کند تا تست‌ها و curl flow از آن استفاده کنند.
- npm test باید با Jest + Supertest اجرا شود و تست‌های auth.*.test.ts پاس شوند.

قرارداد تست:
- تست‌های Jest:
  - auth.register.test.ts:
    - باید بتوانیم کاربر جدید با email "test@example.com" و password "password123" ثبت کنیم و 201 بگیریم و token و user برگردد.
  - auth.login.test.ts:
    - باید بتوانیم همین کاربر را login کنیم و 200 بگیریم و token و user برگردد.
  - auth.me.test.ts:
    - باید بتوانیم با token دریافتی از login، /back/api/auth/me را بزنیم و 200 بگیریم و user بدون passwordHash را ببینیم.
- DB: SQLite + Drizzle، جدول users با ستون‌های: id, email, passwordHash, firstName, lastName, phoneNumber, createdAt, updatedAt.

محدودیت‌ها:
- backend باید ESM باشد:
  - در package.json: "type": "module"
  - در tsconfig.json: "module": "NodeNext", "moduleResolution": "NodeNext"
  - همه import/exportها به صورت ESM (import/export) باشند.
- Jest + ts-jest برای TypeScript و ESM تنظیم شود.
- TypeScript:
  - "target": "ES2020" یا بالاتر.
  - "types": ["node", "jest"] برای شناخت describe/it/expect.
- هیچ لوپ agent در runtime ایجاد نکن؛ کد agent باید deterministic باشد.

خروجی برای هر فایل باید یک TypeScript/JS کاملاً self-contained باشد.
`.trim();

// ---------- Planner Prompt ----------
const PLANNER_SYSTEM_PROMPT = `
تو یک planner برای یک Agent بک‌اند هستی.
خروجی تو باید دقیقاً و فقط یک JSON معتبر باشد.
هیچ متن اضافی، هیچ توضیح، هیچ مارک‌داون و هیچ \`\`\` برنگردان.

ساختار خروجی:
{
  "ready_for_user_review": boolean,
  "changes": [
    {
      "target_files": string[],
      "reason": string,
      "actions": string[]
    }
  ],
  "notes": string
}

Goal profile: "${GOAL}"

Required backend files (spec):
${REQUIRED_BACKEND_FILES.map((f) => `- ${f}`).join("\n")}

Definition of Done (frontend profile):
- ساختار فایل‌ها تا حد لازم برای پیاده‌سازی login/register/me وجود داشته باشد.
- endpointهای زیر پیاده‌سازی شده باشند و با قرارداد API/api2.ts سازگار باشند:
  - POST /back/api/auth/login
  - GET  /back/api/auth/me
  - POST /back/api/auth/register
- bcrypt + JWT + validation + Drizzle + SQLite پیاده‌سازی شده باشد.
- CORS برای ${FRONTEND_ORIGIN} تنظیم شده باشد.

Definition of Done (quality profile):
- همه موارد frontend profile +
- تست‌های login/register/me پاس کنند (npm test).

قوانین:
- در هر فراخوانی agent فقط یک بار اجرا می‌شود (هیچ لوپی وجود ندارد).
- اگر بک‌اند تقریباً خالی است (بیشتر فایل‌های موردنیاز وجود ندارند)، سعی کن در این plan چند فایل پایه‌ای (مثلاً تا 3 فایل) برای نزدیک شدن به ساختار مشخص‌شده بسازی:
  - اولویت: package.json, tsconfig.json, drizzle.config.ts, jest.config.cjs, src/app.ts.
- در هر plan حداکثر 2-3 فایل در target_files بگذار.
- اگر ساختار لایه‌ای رعایت نشده، پیشنهاد refactor به ساختار مشخص‌شده بده.
`.trim();

// ---------- Utility: JSON safe parse ----------
function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ---------- Utility: normalize content for diff ----------
function normalizeContent(str) {
  return String(str || "").replace(/\r/g, "").trim();
}

// ---------- Ensure backend root dir exists (ساخت فقط فولدر، نه کد) ----------
function ensureBackendDirs() {
  if (!fs.existsSync(BACKEND_ROOT)) {
    fs.mkdirSync(BACKEND_ROOT, { recursive: true });
  }
  for (const d of REQUIRED_BACKEND_DIRS) {
    const abs = path.join(BACKEND_ROOT, d);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    }
  }
}

// ---------- Summarize backend + read frontend contract ----------
async function summarizeBackendFiles() {
  const filesResponse = await listBackendFiles({ dir: BACKEND_CWD_REL });

  if (!filesResponse || !filesResponse.success) {
    return "<failed to list backend files>";
  }

  const allEntries = Array.isArray(filesResponse.files)
    ? filesResponse.files
    : [];

  const lines = allEntries.map((e) => {
    const kind = e.is_dir ? "DIR " : "FILE";
    return `${kind}: ${e.path}`;
  });

  const existingPaths = new Set(
    allEntries.map((e) =>
      e.path.replace(/^backend[\\/]/, "").replace(/^[\\/]/, "")
    )
  );

  const missing = REQUIRED_BACKEND_FILES.filter((p) => !existingPaths.has(p));
  lines.push("");
  lines.push(
    `Missing(required spec): ${
      missing.length ? missing.join(", ") : "<none>"
    }`
  );

  try {
    if (fs.existsSync(FRONTEND_AUTH_CONTRACT_PATH)) {
      const res = await readFrontendFile({ path: FRONTEND_AUTH_CONTRACT_PATH });
      if (res.success && typeof res.content === "string") {
        lines.push("");
        lines.push(
          "---- FRONTEND AUTH CONTRACT (API/api2.ts) snippet ----"
        );
        lines.push(res.content.slice(0, 1600));
        lines.push("---- END FRONTEND AUTH CONTRACT snippet ----");
      }
    }
  } catch {
    // ignore
  }

  return lines.join("\n");
}

// ---------- Planner call ----------
async function callPlanner({ testStatus, filesSummary, curlStatus, userInput }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `
ورودی کاربر (از ترمینال/curl):
${userInput || "<none>"}

وضعیت تست‌ها:
${testStatus || "<not run>"}

وضعیت curl flow:
${curlStatus || "not_provided"}

خلاصه ساختار فایل‌های بک‌اند و snippet از قرارداد فرانت‌اند:
${filesSummary}

وظیفه:
- با توجه به ورودی کاربر و وضعیت فعلی پروژه، برنامه‌ریزی کن کدام فایل‌ها باید ایجاد/اصلاح شوند.
- وقتی backend تقریباً خالی است، از بین فایل‌های موردنیاز spec (لیست بالا) مهم‌ترین‌ها را انتخاب کن.
- حداکثر 2-3 فایل در target_files بگذار.
- خروجی فقط JSON معتبر مطابق schema.
`.trim(),
      },
    ],
    temperature: 0,
  });

  const text = resp.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Planner returned non-JSON. Raw:\n", text);
    throw parsed.error;
  }
  return parsed.value;
}

// ---------- Code generation for a specific file ----------
async function generateFullFileContent({
  relPath,
  currentContent,
  change,
  testStatus,
  userInput,
}) {
  const fileEditPrompt = `
نام فایل (نسبت به backend/): ${relPath}

ورودی کاربر (از ترمینال/curl):
${userInput || "<none>"}

محتوای فعلی (اگر خالی است یعنی وجود ندارد یا قابل خواندن نبود):
----------------
${currentContent || ""}
----------------

دلیل تغییر (از planner):
${change.reason || "N/A"}

اقدامات لازم (از planner):
- ${(change.actions || []).join("\n- ")}

اطلاعات کمکی تست‌ها:
${testStatus || "<not run>"}

نیازمندی مهم:
- ساختار پروژه باید مطابق spec لایه‌ای (Fastify + TS + Drizzle + SQLite) باشد.
- endpointهای auth باید با قرارداد API/api2.ts سازگار باشند:
  - POST /back/api/auth/login
  - GET  /back/api/auth/me
  - POST /back/api/auth/register
- پاسخ login/register باید فیلد token یا access_token داشته باشد.
- bcrypt برای hash password، JWT برای token، Drizzle برای DB.
- backend بر اساس ESM است:
  - package.json: "type": "module"
  - tsconfig.module: "NodeNext"
  - همه importها و exportها از syntax ESM استفاده کنند.

لطفاً کل محتوای جدید این فایل را فقط به شکل کد برگردان. هیچ توضیحی ننویس.
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: fileEditPrompt },
    ],
    temperature: 0.2,
  });

  return resp.choices?.[0]?.message?.content || "";
}

// ---------- File write helper ----------
async function writeBackendFile({ relPath, content }) {
  const absPath = path.join(BACKEND_ROOT, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // اگر ابزار editFile انتظار امضای (path, content) دارد:
  await editFile({
    path: absPath,
    content,
  });
}

// ---------- Curl flow test (login + me) ----------
async function runCurlAuthFlow() {
  // فقط برای دیباگ، اجباری نیست و نتیجه‌اش روند را متوقف نمی‌کند
  try {
    const distApp = path.join(BACKEND_ROOT, "dist", "app.js");
    let cmd;
    if (fs.existsSync(distApp)) {
      cmd =
        'NODE_ENV=production PORT=3000 node dist/app.js > /tmp/backend_agent_server.log 2>&1 &';
    } else if (fs.existsSync(path.join(BACKEND_ROOT, "src", "app.ts"))) {
      cmd =
        'NODE_ENV=production PORT=3000 npx ts-node-dev --respawn --transpile-only src/app.ts > /tmp/backend_agent_server.log 2>&1 &';
    } else {
      return {
        success: false,
        stage: "startup",
        error: "no app entry (src/app.ts or dist/app.js) found",
      };
    }

    await runBackendCommand({
      cmd,
      cwd: BACKEND_CWD_REL,
    });
  } catch (e) {
    return {
      success: false,
      stage: "startup-exec",
      error: String(e),
    };
  }

  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      const check = await runBackendCommand({
        cmd: `curl -s -o /dev/null -w "%{http_code}" ${APP_URL}/health`,
        cwd: BACKEND_CWD_REL,
      });

      if ((check.stdout || "").trim() === "200") {
        ready = true;
        break;
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }

  if (!ready) {
    return {
      success: false,
      stage: "startup",
      error: "server never became ready",
    };
  }

  const loginPayload = JSON.stringify({
    email: "test@example.com",
    password: "password123",
  });

  try {
    const loginCmd = `${CURL_BIN} -s -o /tmp/login_body.json -w "%{http_code}" -H "Content-Type: application/json" -d '${loginPayload}' ${APP_URL}/back/api/auth/login`;
    const loginRes = await runBackendCommand({ cmd: loginCmd });

    const loginStatus = (loginRes.stdout || "").trim();
    const loginBodyRaw = fs.readFileSync("/tmp/login_body.json", "utf8");
    const loginBody = safeJsonParse(loginBodyRaw);

    if (loginStatus !== "200" || !loginBody.ok) {
      return {
        success: false,
        stage: "login-status",
        status: loginStatus,
        body: loginBodyRaw,
      };
    }

    const data = loginBody.value;
    const token = data.token || data.access_token;
    if (!token) {
      return {
        success: false,
        stage: "login-token-missing",
        body: loginBody.value,
      };
    }

    const meCmd = `${CURL_BIN} -s -o /tmp/me_body.json -w "%{http_code}" -H "Authorization: Bearer ${token}" ${APP_URL}/back/api/auth/me`;
    const meRes = await runBackendCommand({ cmd: meCmd });

    const meStatus = (meRes.stdout || "").trim();
    const meBodyRaw = fs.readFileSync("/tmp/me_body.json", "utf8");
    const meBody = safeJsonParse(meBodyRaw);

    if (meStatus !== "200" || !meBody.ok) {
      return {
        success: false,
        stage: "me-status",
        status: meStatus,
        body: meBodyRaw,
      };
    }

    return { success: true };
  } catch (e) {
    return {
      success: false,
      stage: "curl-exception",
      error: String(e),
    };
  }
}

// ---------- helper: parse Jest result ----------
function interpretTestResult(raw) {
  if (!raw) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      noTestSpecified: true,
      success: false,
    };
  }

  const stdout = raw?.stdout || "";
  const stderr = raw?.stderr || "";
  const combined = `${stdout}\n${stderr}`;

  const exitCode =
    raw?.exitCode ?? raw?.code ?? (raw?.success === true ? 0 : 1);

  const noTestSpecified =
    combined.includes("Error: no test specified") ||
    combined.includes("No tests found");

  const success = exitCode === 0 && !noTestSpecified;

  return {
    ...raw,
    stdout,
    stderr,
    exitCode,
    noTestSpecified,
    success,
  };
}

// ---------- Read user input (for chat-like interaction) ----------
async function readUserInput() {
  if (process.env.BACKEND_AGENT_INPUT) {
    return process.env.BACKEND_AGENT_INPUT;
  }

  // اگر از stdin چیزی آمده باشد، آن را می‌خوانیم
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text.length > 0) return text;
  }

  return "";
}

// ---------- Main single-step agent ----------
export async function runBackendAgent() {
  // eslint-disable-next-line no-console
  console.log(
    "🤖 Single-step backend agent (Fastify + TS + Drizzle, ESM) started..."
  );
  // eslint-disable-next-line no-console
  console.log("Backend root:", BACKEND_ROOT);
  // eslint-disable-next-line no-console
  console.log("Goal profile:", GOAL);

  ensureBackendDirs();

  const userInput = await readUserInput();

  // 1) Optional: run tests (info only, نه شرط توقف)
  let testStatus = "<not run>";
  try {
    const rawTestResult = await runBackendTests({
      cmd: "npm test",
      cwd: BACKEND_CWD_REL,
    });
    const testResult = interpretTestResult(rawTestResult);
    testStatus = `
TEST_EXIT_CODE: ${testResult.exitCode}
TEST_SUCCESS: ${testResult.success}
NO_TESTS_FOUND: ${testResult.noTestSpecified}

STDOUT:
${testResult.stdout.slice(-500)}

STDERR:
${testResult.stderr.slice(-500)}
`.trim();
  } catch (e) {
    testStatus = `Test run failed: ${String(e)}`;
  }

  // 2) Optional: run curl flow (info only)
  let curlStatus = "<not run>";
  try {
    const curlDetails = await runCurlAuthFlow();
    curlStatus = JSON.stringify(curlDetails, null, 2);
  } catch (e) {
    curlStatus = `Curl flow failed: ${String(e)}`;
  }

  // 3) Files summary
  let filesSummary = "<failed to summarize>";
  try {
    filesSummary = await summarizeBackendFiles();
  } catch (e) {
    filesSummary = `<failed to summarize: ${String(e)}>`;
  }

  // 4) Planner: یک بار
  let plan;
  try {
    plan = await callPlanner({
      testStatus,
      filesSummary,
      curlStatus,
      userInput,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("❌ Planner failed:", e);
    return;
  }

  // eslint-disable-next-line no-console
  console.log("📋 Plan:", JSON.stringify(plan, null, 2));

  const changes = Array.isArray(plan?.changes) ? plan.changes : [];

  // 5) Apply changes (حداکثر چند فایل، بدون لوپ)
  for (const change of changes) {
    const targetFiles = Array.isArray(change?.target_files)
      ? change.target_files
      : [];

    for (const rel of targetFiles) {
      const cleaned = rel.startsWith("backend/")
        ? rel.replace(/^backend[\\/]/, "")
        : rel;

      const abs = path.join(BACKEND_ROOT, cleaned);

      let currentContent = "";
      if (fs.existsSync(abs)) {
        try {
          const res = await readFile({ path: abs });
          currentContent =
            typeof res === "string"
              ? res
              : typeof res?.content === "string"
              ? res.content
              : "";
        } catch {
          currentContent = "";
        }
      }

      // eslint-disable-next-line no-console
      console.log(`✏️ Generating content for: ${cleaned}`);

      let newContent = await generateFullFileContent({
        relPath: cleaned,
        currentContent,
        change,
        testStatus,
        userInput,
      });

      newContent = String(newContent).trim();

      if (newContent.startsWith("```")) {
newContent = newContent
.replace(/^```[a-zA-Z]*\n?/, "")
          .replace(/```$/, "")
.trim();
}

const currentNormalized = normalizeContent(currentContent);
const newNormalized = normalizeContent(newContent);

if (newNormalized === currentNormalized) {
// eslint-disable-next-line no-console
console.log(`⚪ No changes for: ${cleaned}`);
continue;
}

try {
await writeBackendFile({
relPath: cleaned,
content: newContent,
});

// eslint-disable-next-line no-console
console.log(
`✅ File updated: ${cleaned} (len=${newContent.length})`
);
} catch (e) {
// eslint-disable-next-line no-console
console.error(`❌ Failed to write ${cleaned}:`, e);
}
}
  }

  // 6) Chat-like answer به خود کاربر (خلاصه خروجی)
  if (userInput && userInput.length > 0) {
const chatResp = await openai.chat.completions.create({
model: "gpt-4.1",
messages: [
{
role: "system",
content:
"تو یک دستیار فنی بک‌اند هستی. به زبان فارسی، مختصر و دقیق، توضیح بده که در این مرحله چه کارهایی برای کاربر انجام شد و چه قدم بعدی پیشنهاد می‌کنی.",
},
{
role: "user",
content: `
پیام کاربر:
${userInput}

Plan اعمال‌شده:
${JSON.stringify(plan, null, 2)}
`.trim(),
},
],
temperature: 0.3,
});

const answer = chatResp.choices?.[0]?.message?.content || "";
// پاسخ به صورت متن روی stdout (تا در ترمینال / curl به کاربر برسد)
// eslint-disable-next-line no-console
console.log("\n💬 پاسخ Agent برای شما:\n");
// eslint-disable-next-line no-console
console.log(answer.trim());
  }

  // eslint-disable-next-line no-console
  console.log(
"\n🏁 Single-step backend agent execution finished (no loop)."
  );
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  runBackendAgent().catch((err) => {
// eslint-disable-next-line no-console
console.error("❌ Backend agent crashed:", err);
process.exit(1);
  });
}
