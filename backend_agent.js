// backend_agent.js (ESM) - Advanced Backend Agent (Auth + Layered Structure)

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import OpenAI from "openai";

import { runBackendCommand } from "./tools/run_backend_command.js";
import { runBackendTests } from "./tools/runBackendTests.js";
import { readProjectFile as readFile } from "./tools/readProjectFile.js";
import { editFile } from "./tools/editFile.js";
import { listBackendFiles } from "./tools/list_backend_files.js";

// OPTIONAL: for reading frontend files (login-app)
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
const FRONTEND_ROOT = path.join(process.cwd(), "login-app");

const HARD_MAX_STEPS = Number(process.env.BACKEND_HARD_MAX_STEPS || 45);

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const APP_URL = process.env.BACKEND_APP_URL || "http://localhost:4000";

// Curl is used to simulate frontend calls
const CURL_BIN = process.env.CURL_BIN || "curl";

// Goal profile: "frontend" یا "quality"
const GOAL = (process.env.BACKEND_GOAL || "frontend").toLowerCase();

// ---------- LLM Setup ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-kwT53wRAXygEY2vdQSrO4HA0tNYTtXuQrBH2QeVbCuKu8oDy",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

/**
 * IMPORTANT SECURITY NOTE
 * Never commit real API keys into the repository.
 */

// ---------- Structure Spec ----------
const REQUIRED_BACKEND_FILES = [
  "app.js",
  "server.js",
  "db.js",
  "config/auth.config.js",
  "routes/auth.routes.js",
  "controllers/auth.controller.js",
  "services/auth.service.js",
  "models/user.model.js",
  "models/token.model.js",
  "middleware/auth.middleware.js",
  "utils/jwt.js",
];

const REQUIRED_BACKEND_DIRS = [
  "config",
  "routes",
  "controllers",
  "services",
  "models",
  "middleware",
  "utils",
  "__tests__",
];

// ---------- System Prompt (Coder) ----------
const SYSTEM_PROMPT = `
تو یک Agent ارشد بک‌اند هستی که با Node.js (ESM) + Express + SQLite کار می‌کنی.

هدف:
- پیاده‌سازی سیستم احراز هویت production-quality با دو endpoint:
  - POST /api/login
  - POST /api/refresh
- معماری لایه‌ای و ساختار فایل‌ها دقیقاً باید مطابق این ساختار باشد:
  backend/
  ├── app.js
  ├── server.js
  ├── db.js
  ├── config/
  │   └── auth.config.js
  ├── routes/
  │   └── auth.routes.js
  ├── controllers/
  │   └── auth.controller.js
  ├── services/
  │   └── auth.service.js
  ├── models/
  │   ├── user.model.js
  │   └── token.model.js
  ├── middleware/
  │   └── auth.middleware.js
  ├── utils/
  │   └── jwt.js
  └── __tests__/

الزامات امنیتی:
- استفاده از bcrypt برای hash رمز عبور.
- استفاده از JWT برای access token با expiry کوتاه (مثلاً 15m).
- استفاده از JWT برای refresh token با expiry بلندتر (مثلاً 7d).
- Refresh token rotation اجباری است:
  - هر refresh موفق باید refresh token جدید بدهد
  - refresh token قبلی باید revoke/invalid شود (DB-backed)
  - reuse کردن refresh token revoked باید با 401 رد شود
- refresh token ها باید در SQLite ذخیره شوند (session/token table) و قابلیت revoke داشته باشند.

الزامات کیفیت:
- جداسازی concerns: routes/controller/service/model/utils/middleware.
- error handling مناسب، status codeهای درست، input validation حداقلی.
- CORS باید برای ${FRONTEND_ORIGIN} تنظیم شود.
- server.js فقط در صورت NODE_ENV !== "test" گوش بدهد و app را export کند.
- تست‌ها: Jest + Supertest در backend/__tests__/.

قرارداد با frontend (login-app):
- Endpoints:
  - POST http://localhost:4000/api/login
- Body:
  - { "email": string, "password": string }
- روی success:
  - status code: 200
  - body JSON:
    {
      "user": { "id": number, "email": string, "name"?: string },
      "accessToken": string,
      "refreshToken": string
    }
- روی خطا:
  - status code: 4xx
  - body JSON:
    { "error": string }  // frontend از این فیلد استفاده می‌کند
- frontend با credential تست زیر کار می‌کند:
  - email: "test@example.com"
  - password: "password123"
  => باید یک کاربر seed با این credential در DB داشته باشی.

قوانین ویرایش فایل:
- هر بار فقط محتوای کامل فایل را برگردان (self-contained).
- هیچ متن اضافه‌ای خارج از کد نده.
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

Definition of Done (frontend profile):
- ساختار فایل‌ها تا حد لازم برای پیاده‌سازی login/refresh وجود داشته باشد.
- /api/login و /api/refresh پیاده‌سازی شده باشند.
- bcrypt + JWT + refresh rotation + DB storage/revocation پیاده‌سازی شده باشد.
- CORS برای ${FRONTEND_ORIGIN} تنظیم شده باشد.
- اجرای curl flow موفق باشد:
  - login => دریافت accessToken و refreshToken
  - refresh => دریافت accessToken و refreshToken جدید
  - reuse refreshToken قبلی => 401 یا 403

Definition of Done (quality profile):
- همه موارد frontend profile +
- Jest + Supertest تست‌های login/refresh/security را پاس کنند.

قوانین:
- در frontend profile:
  - اگر curl flow موفق بود، می‌توانی ready_for_user_review را true کنی حتی اگر تست‌ها کامل نیستند.
- در quality profile:
  - اگر تست‌ها اجرا نمی‌شوند (No tests found / no test specified)، اول زیرساخت تست را درست کن.
  - ready_for_user_review فقط وقتی true شود که هم تست‌ها و هم curl flow موفق باشند.
- در هر مرحله حداکثر 2-3 فایل را هدف بگیر (هزینه).
- اگر ساختار لایه‌ای رعایت نشده، refactor پیشنهاد بده.
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
  return String(str || "")
    .replace(/\r/g, "")
    .trim();
}

// ---------- Create skeletons ONLY IF backend is fresh ----------
function createBackendSkeletonFiles() {
  const skeletons = {
    "app.js": `import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";

const app = express();

app.use(cors({
  origin: "${FRONTEND_ORIGIN}",
  credentials: true,
}));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", authRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message = err.message || "Internal server error";
  res.status(status).json({ error: message });
});

export default app;
`,

    "server.js": `import http from "http";
import app from "./app.js";
import { initUserModel } from "./models/user.model.js";
import { initTokenModel } from "./models/token.model.js";

initUserModel();
initTokenModel();

const PORT = process.env.PORT || 4000;

let serverInstance = null;

if (process.env.NODE_ENV !== "test") {
  serverInstance = http.createServer(app);
  serverInstance.listen(PORT, () => {
    console.log(\`Server listening on port \${PORT}\`);
  });
}

export default app;
export { serverInstance };
`,

    "db.js": `import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, "database.sqlite");

const db = new sqlite3.Database(dbPath);

export default db;
`,

    "config/auth.config.js": `export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev_access_secret_change_me";
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev_refresh_secret_change_me";

export const ACCESS_TOKEN_EXPIRES_IN = "15m";
export const REFRESH_TOKEN_EXPIRES_IN = "7d";
`,

    "routes/auth.routes.js": `import { Router } from "express";
import { login, refreshToken } from "../controllers/auth.controller.js";

const router = Router();

router.post("/login", login);
router.post("/refresh", refreshToken);

export default router;
`,

    "controllers/auth.controller.js": `import * as authService from "../services/auth.service.js";

export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login({ email, password });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function refreshToken(req, res, next) {
  try {
    const { refreshToken } = req.body || {};
    const result = await authService.refreshToken({ refreshToken });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
`,

    "services/auth.service.js": `import bcrypt from "bcrypt";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { findUserByEmail } from "../models/user.model.js";
import {
  createRefreshTokenRecord,
  findRefreshTokenRecord,
  rotateRefreshTokenRecord,
} from "../models/token.model.js";

export async function login({ email, password }) {
  if (!email || !password) {
    const error = new Error("Email and password are required");
    error.status = 400;
    throw error;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }

  const accessToken = signAccessToken({ userId: user.id });
  const refreshJwt = signRefreshToken({ userId: user.id });
  await createRefreshTokenRecord({ userId: user.id, token: refreshJwt });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name || null,
    },
    accessToken,
    refreshToken: refreshJwt,
  };
}

export async function refreshToken({ refreshToken }) {
  if (!refreshToken) {
    const error = new Error("Refresh token is required");
    error.status = 400;
    throw error;
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    const error = new Error("Invalid refresh token");
    error.status = 401;
    throw error;
  }

  const existing = await findRefreshTokenRecord(refreshToken);
  if (!existing || existing.is_revoked) {
    const error = new Error("Refresh token revoked or not found");
    error.status = 401;
    throw error;
  }

  const newAccessToken = signAccessToken({ userId: payload.userId });
  const newRefreshJwt = signRefreshToken({ userId: payload.userId });

  await rotateRefreshTokenRecord({
    oldToken: refreshToken,
    newToken: newRefreshJwt,
    userId: payload.userId,
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshJwt,
  };
}
`,

    "models/user.model.js": `import db from "../db.js";
import bcrypt from "bcrypt";

export function initUserModel() {
  db.serialize(() => {
    db.run(
      \`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )\`
    );

    const email = "test@example.com";
    const plainPassword = "password123";
    const saltRounds = 10;
    const passwordHash = bcrypt.hashSync(plainPassword, saltRounds);

    db.run(
      \`INSERT OR IGNORE INTO users (email, password_hash, name)
       VALUES (?, ?, ?)\`,
      [email, passwordHash, "Test User"]
    );
  });
}

export function findUserByEmail(email) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}
`,

    "models/token.model.js": `import db from "../db.js";

export function initTokenModel() {
  db.serialize(() => {
    db.run(
      \`CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        is_revoked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )\`
    );
  });
}

export function createRefreshTokenRecord({ userId, token }) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO refresh_tokens (user_id, token, is_revoked) VALUES (?, ?, 0)",
      [userId, token],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID });
      }
    );
  });
}

export function findRefreshTokenRecord(token) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM refresh_tokens WHERE token = ?",
      [token],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function revokeRefreshTokenRecord(token) {
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE refresh_tokens SET is_revoked = 1 WHERE token = ?",
      [token],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

export async function rotateRefreshTokenRecord({ oldToken, newToken, userId }) {
  await revokeRefreshTokenRecord(oldToken);
  await createRefreshTokenRecord({ userId, token: newToken });
}
`,

    "middleware/auth.middleware.js": `import { verifyAccessToken } from "../utils/jwt.js";

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing access token" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.userId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
`,

    "utils/jwt.js": `import jwt from "jsonwebtoken";
import {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
} from "../config/auth.config.js";

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}
`,
  };

  for (const rel of REQUIRED_BACKEND_FILES) {
    const abs = path.join(BACKEND_ROOT, rel);
    if (!fs.existsSync(abs)) {
      const content = skeletons[rel] || "// TODO: implemented by AI\n";
      const dir = path.dirname(abs);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      console.log(`📄 Created skeleton: ${rel}`);
    }
  }
}

// ---------- Ensure backend ----------
function backendExists() {
  return (
    fs.existsSync(BACKEND_ROOT) &&
    fs.existsSync(path.join(BACKEND_ROOT, "package.json"))
  );
}

function ensureBackendInitialized() {
  if (backendExists()) {
    console.log("✅ Existing backend detected. Skipping initialization.");
    return;
  }

  console.log("📂 backend folder not found or missing package.json. Creating fresh backend skeleton...");
  fs.mkdirSync(BACKEND_ROOT, { recursive: true });

  for (const d of REQUIRED_BACKEND_DIRS) {
    const abs = path.join(BACKEND_ROOT, d);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  }

  const packageJsonPath = path.join(BACKEND_ROOT, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.log("📦 package.json not found. Initializing npm project...");
    execSync("npm init -y", { cwd: BACKEND_ROOT, stdio: "inherit" });
  }

  const pkgRaw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(pkgRaw);

  pkg.type = "module";
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = "node --experimental-vm-modules node_modules/jest/bin/jest.js";
  pkg.scripts.start = pkg.scripts.start || "node server.js";

  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), "utf8");

  const nodeModulesPath = path.join(BACKEND_ROOT, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log("⬇️ Installing backend dependencies...");
    execSync("npm install express cors sqlite3 jsonwebtoken bcrypt", {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
    });
    execSync("npm install -D jest supertest", {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
    });
  } else {
    console.log("✅ node_modules exists. Skipping npm install.");
  }

  const jestConfigPath = path.join(BACKEND_ROOT, "jest.config.cjs");
  if (!fs.existsSync(jestConfigPath)) {
    const jestConfig = `const config = {
  testEnvironment: "node",
  verbose: true,
  testMatch: ["**/__tests__/**/*.test.js"],
};

module.exports = config;

`;
    fs.writeFileSync(jestConfigPath, jestConfig, "utf8");
  }

  createBackendSkeletonFiles();
}

// ---------- Summarize backend (+ optional frontend snippet) ----------
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

  const missing = REQUIRED_BACKEND_FILES.filter(
    (p) => !existingPaths.has(p)
  );
  lines.push("");
  lines.push(
    `Missing(required spec): ${missing.length ? missing.join(", ") : "<none>"}`
  );

  try {
    const appPath = path.join(FRONTEND_ROOT, "src", "App.tsx");
    const altAppPath = path.join(FRONTEND_ROOT, "src", "App.jsx");
    let frontendContent = null;

    if (fs.existsSync(appPath)) {
      const res = await readFrontendFile({ path: appPath });
      if (res.success) frontendContent = res.content.slice(0, 800);
    } else if (fs.existsSync(altAppPath)) {
      const res = await readFrontendFile({ path: altAppPath });
      if (res.success) frontendContent = res.content.slice(0, 800);
    }

    if (frontendContent) {
      lines.push("");
      lines.push("---- FRONTEND (login-app) snippet ----");
      lines.push(frontendContent);
      lines.push("---- END FRONTEND snippet ----");
    }
  } catch {
    // ignore
  }

  return lines.join("\n");
}

// ---------- Planner call ----------
async function callPlanner({ testStatus, filesSummary, curlStatus }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `
وضعیت تست‌ها:
${testStatus}

وضعیت curl flow:
${curlStatus || "not_provided"}

خلاصه ساختار فایل‌های بک‌اند و بخشی از frontend:
${filesSummary}

وظیفه:
- برنامه‌ریزی کن چه فایل‌هایی باید ایجاد/اصلاح شوند تا به Definition of Done برسیم.
- در هر مرحله حداکثر 2-3 فایل در target_files بگذار.
- خروجی فقط JSON معتبر مطابق schema.
`.trim(),
      },
    ],
    temperature: 0,
  });

  const text = resp.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
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
}) {
  const fileEditPrompt = `
نام فایل (نسبت به backend/): ${relPath}

محتوای فعلی (اگر خالی است یعنی وجود ندارد یا قابل خواندن نبود):
----------------
${currentContent || ""}
----------------

دلیل تغییر:
${change.reason || "N/A"}

اقدامات لازم:
- ${(change.actions || []).join("\n- ")}

وضعیت تست‌ها:
${testStatus}

نیازمندی مهم:
- ساختار پروژه باید دقیقاً مطابق spec لایه‌ای باشد.
- login/refresh با refresh rotation و SQLite-backed tokens.
- برای endpoint /api/login خروجی باید با این قرارداد سازگار باشد:
  - روی موفق:
    status 200
    body: { user: { id, email, name? }, accessToken, refreshToken }
  - روی خطا:
    status 4xx
    body: { error: string }
- تست‌ها باید با Jest+Supertest پاس شوند.

لطفاً کل محتوای جدید این فایل را فقط به شکل کد برگردان. هیچ توضیحی ننویس.
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
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
  await editFile({ filePath: absPath, newContent: content });
}

// ---------- Curl flow test ----------
async function runCurlAuthFlow() {
  console.log("🌐 Running curl auth flow test...");

  // Kill existing server
  try {
    await runBackendCommand({
      cmd: `lsof -ti tcp:4000 | xargs -r kill -9`,
      cwd: BACKEND_CWD_REL,
    });
  } catch (_) {}

  // Start server in background
  try {
    await runBackendCommand({
      cmd: `NODE_ENV=production PORT=4000 node server.js > /tmp/backend_agent_server.log 2>&1 &`,
      cwd: BACKEND_CWD_REL,
    });
  } catch (e) {
    console.warn("⚠️ Server start failed, continuing anyway:", e);
  }

  // Wait until port is open (robust)
  let ready = false;
  for (let i = 0; i < 25; i++) {
    try {
      const check = await runBackendCommand({
        cmd: `curl -s -o /dev/null -w "%{http_code}" ${APP_URL}/health`,
        cwd: BACKEND_CWD_REL,
      });

      if ((check.stdout || "").trim() === "200") {
        ready = true;
        break;
      }
    } catch {}
    await sleep(200);
  }

  if (!ready) {
    return {
      success: false,
      stage: "startup",
      error: "server never became ready",
    };
  }

  // LOGIN
  const loginPayload = JSON.stringify({
    email: "test@example.com",
    password: "password123",
  });

  const loginCmd = `${CURL_BIN} -s -o /tmp/login_body.json -w "%{http_code}" -H "Content-Type: application/json" -d '${loginPayload}' ${APP_URL}/api/login`;
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

  const { accessToken, refreshToken } = loginBody.value;
  if (!accessToken || !refreshToken) {
    return {
      success: false,
      stage: "login-tokens",
      body: loginBody.value,
    };
  }

  // FIRST REFRESH
  const refreshPayload = JSON.stringify({ refreshToken });
  const refreshCmd = `${CURL_BIN} -s -o /tmp/refresh_body.json -w "%{http_code}" -H "Content-Type: application/json" -d '${refreshPayload}' ${APP_URL}/api/refresh`;
  const refreshRes = await runBackendCommand({ cmd: refreshCmd });

  const refreshStatus = (refreshRes.stdout || "").trim();
  const refreshBodyRaw = fs.readFileSync("/tmp/refresh_body.json", "utf8");
  const refreshBody = safeJsonParse(refreshBodyRaw);

  if (refreshStatus !== "200" || !refreshBody.ok) {
    return {
      success: false,
      stage: "refresh-status",
      status: refreshStatus,
      body: refreshBodyRaw,
    };
  }

  const newRefresh = refreshBody.value.refreshToken;
  if (!newRefresh) {
    return {
      success: false,
      stage: "refresh-token-missing",
      body: refreshBody.value,
    };
  }

  // REUSE OLD refreshToken → MUST FAIL
  const reuseCmd = `${CURL_BIN} -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" -d '${refreshPayload}' ${APP_URL}/api/refresh`;
  const reuseRes = await runBackendCommand({ cmd: reuseCmd });
  const reuseStatus = (reuseRes.stdout || "").trim();

  const reuseValid = reuseStatus === "401" || reuseStatus === "403";
  if (!reuseValid) {
    return {
      success: false,
      stage: "reuse-old-refresh",
      status: reuseStatus,
    };
  }

  // TEST NEW refreshToken WORKS
  const secondPayload = JSON.stringify({ refreshToken: newRefresh });
  const secondCmd = `${CURL_BIN} -s -o /tmp/second_refresh_body.json -w "%{http_code}" -H "Content-Type: application/json" -d '${secondPayload}' ${APP_URL}/api/refresh`;
  const secondRes = await runBackendCommand({ cmd: secondCmd });

  const secondStatus = (secondRes.stdout || "").trim();
  const secondBodyRaw = fs.readFileSync("/tmp/second_refresh_body.json", "utf8");
  const secondBody = safeJsonParse(secondBodyRaw);

  if (secondStatus !== "200" || !secondBody.ok) {
    return {
      success: false,
      stage: "new-refresh-should-work",
      status: secondStatus,
      body: secondBodyRaw,
    };
  }

  return { success: true };
}

// ---------- Ensure test infrastructure + placeholder tests ----------
function ensureTestInfrastructure() {
  const testsDir = path.join(BACKEND_ROOT, "__tests__");
  if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });

  const existing = fs
    .readdirSync(testsDir)
    .filter((n) => n.endsWith(".test.js") || n.endsWith(".spec.js"));

  if (existing.length === 0) {
    const smokePath = path.join(testsDir, "smoke.test.js");
    const smoke = `import request from "supertest";
import app from "../server.js";

describe("smoke", () => {
  it("healthcheck works", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });
});
`;
    fs.writeFileSync(smokePath, smoke, "utf8");
  }
}

// ---------- helper: parse Jest result ----------
function interpretTestResult(raw) {
  const stdout = raw?.stdout || "";
  const stderr = raw?.stderr || "";
  const combined = `${stdout}\n${stderr}`;

  const exitCode =
    raw?.exitCode ??
    raw?.code ??
    (raw?.success === true ? 0 : 1);

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

export async function runBackendAgent() {
  console.log("🤖 Starting advanced backend agent (Optimized Logic)...");
  console.log("Backend root:", BACKEND_ROOT);
  console.log("Goal profile:", GOAL);

  ensureBackendInitialized();
  ensureTestInfrastructure();

  let step = 0;
  let consecutiveSameErrorCount = 0;
  let lastFailureSignature = "";

  while (step < HARD_MAX_STEPS) {
    step++;
    console.log(
      `\n================ Step ${step}/${HARD_MAX_STEPS} ================`
    );

    const updatedThisStep = new Set();

    // 1) Tests
    console.log("🧪 Running backend tests...");
    let rawTestResult;
    try {
      rawTestResult = await runBackendTests({
        cmd: "npm test",
        cwd: BACKEND_CWD_REL,
      });
    } catch (e) {
      rawTestResult = { success: false, stdout: "", stderr: String(e) };
    }

    const testResult = interpretTestResult(rawTestResult);
    console.log("Jest exitCode:", testResult.exitCode);
    console.log("Jest success detected:", testResult.success);

    const testStatus = `
JEST_EXIT_CODE: ${testResult.exitCode}
JEST_SUCCESS: ${testResult.success}
NO_TESTS_FOUND: ${testResult.noTestSpecified}

STDOUT:
${testResult.stdout.slice(-500)}

STDERR:
${testResult.stderr.slice(-500)}
`.trim();

    // Loop protection on identical failures
    const signature =
      `${testResult.exitCode}::` +
      `${testResult.stderr.slice(0, 150)}::` +
      `${testResult.stdout.slice(0, 150)}`;
    if (!testResult.success && !testResult.noTestSpecified && signature === lastFailureSignature) {
      consecutiveSameErrorCount++;
    } else {
      consecutiveSameErrorCount = 0;
      lastFailureSignature = signature;
    }

    if (consecutiveSameErrorCount >= 3) {
      console.warn("🛑 Loop detected: Failing with same signature for 3 steps. Breaking.");
      break;
    }

    // 2) Curl Auth Flow
    console.log("🌐 Running curl authentication flow...");
    let curlDetails = null;
    try {
      curlDetails = await runCurlAuthFlow();
    } catch (e) {
      curlDetails = { success: false, stage: "exception", error: String(e) };
    }
    const curlStatus = JSON.stringify(curlDetails, null, 2);

    // 3) Files summary
    console.log("📂 Summarizing backend files...");
    let filesSummary = "<failed to summarize>";
    try {
      filesSummary = await summarizeBackendFiles();
    } catch (e) {
      filesSummary = `<failed to summarize: ${String(e)}>`;
    }

    // 4) Planner
    console.log("🧠 Calling planner...");
    let plan;
    try {
      plan = await callPlanner({
        testStatus: `[JEST RESULT]: ${testResult.success ? "PASSED" : "FAILED"}\n${testStatus}`,
        filesSummary,
        curlStatus: `[CURL FLOW]: ${curlDetails.success ? "SUCCESS" : "FAILED"}\n${curlStatus}`,
      });
    } catch (e) {
      console.error("❌ Planner failed:", e);
      break;
    }

    console.log(
      "📋 Plan received. Ready_for_user_review (planner, ignored for stop condition):",
      plan?.ready_for_user_review
    );

    // 5) Stop conditions (no dependency on planner.ready_for_user_review)

    // Primary: tests + curl both green
    if (testResult.success) {
      console.log("🎉 ALL GREEN: Tests passed AND Curl Auth Flow succeeded.");
      console.log("🚀 Agent has reached a production-ready state. Stopping.");
      break;
    }

    // Secondary: Goal-specific nuance (frontend mode can stop on curl)
    if (GOAL === "frontend") {
      if (curlDetails.success) {
        console.log("✅ [frontend goal] Curl flow passing. Stopping.");
        break;
      }
    }

    // 6) Apply planner changes
    const changes = Array.isArray(plan?.changes) ? plan.changes : [];

    if (changes.length === 0) {
      console.log("ℹ️ No changes suggested by planner.");
      if (testResult.success && curlDetails.success) {
        console.log("✅ Tests & curl already green. Stopping.");
        break;
      }
      console.warn("⚠️ Tests/Curl not fully passing but no changes suggested. Breaking to avoid infinite loop.");
      break;
    }

for (const change of changes) {
  const targetFiles = Array.isArray(change?.target_files)
    ? change.target_files
    : [];

  for (const rel of targetFiles) {
    const cleaned = rel.startsWith("backend/")
      ? rel.replace(/^backend[\\/]/, "")
      : rel;

    if (updatedThisStep.has(cleaned)) continue;

    const abs = path.join(BACKEND_ROOT, cleaned);

    let currentContent = "";
    if (fs.existsSync(abs)) {
      try {
        currentContent = await readFile({ filePath: abs });
      } catch {
        currentContent = "";
      }
    }

    console.log(`✏️ Generating content for: ${cleaned}`);

    let newContent = await generateFullFileContent({
      relPath: cleaned,
      currentContent,
      change,
      testStatus,
    });

    newContent = String(newContent).trim();

    // پاک کردن

if (newContent.startsWith("```")) {
      newContent = newContent
        .replace(/^```[a-zA-Z]*\n?/, "")
.replace(/```$/, "")
        .trim();
    }

    const currentNormalized = normalizeContent(currentContent);
    const newNormalized = normalizeContent(newContent);

    // 🔍 DIFF CHECK قوی
    if (newNormalized === currentNormalized) {
      console.log(`⚪ No changes for: ${cleaned}`);
      continue;
    }

    try {
      await writeBackendFile({
        relPath: cleaned,
        content: newContent,
      });

      updatedThisStep.add(cleaned);

      console.log(`✅ File updated: ${cleaned}`);
    } catch (e) {
      console.error(`❌ Failed to write ${cleaned}:`, e);
    }
  }
}


// Secondary stop: no file changed + tests already green -> don't loop forever on curl issues
if (updatedThisStep.size === 0 && testResult.success) {
console.log(
"🟦 No file changes in this step AND tests passed. Stopping to prevent rewrite loop."
);
break;
}

// Small sleep to avoid hammering APIs / FS
await sleep(600);
  }

  if (step >= HARD_MAX_STEPS) {
console.warn(`⚠️ Termination: Reached maximum steps (${HARD_MAX_STEPS}).`);
  }

  console.log("🏁 Advanced backend agent execution finished.");
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBackendAgent().catch((err) => {
console.error("❌ Backend agent crashed:", err);
process.exit(1);
  });
}
