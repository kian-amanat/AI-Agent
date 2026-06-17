// file_agent.mjs
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath, pathToFileURL } from "url";

import { openai, VISION_MODEL } from "./backend1/config/openai.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.cwd();

/**
 * helper: تشخیص ساده نوع فایل بر اساس پسوند
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
    return "image";
  }

  if (ext === ".pdf") return "pdf";
  if ([".txt", ".md", ".log"].includes(ext)) return "text";

  if ([".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".rb", ".go"].includes(ext)) {
    return "code";
  }

  return "unknown";
}

function guessImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\/g, "/");
}

/**
 * Resolve uploaded / relative / absolute paths safely.
 * Supports:
 * - absolute paths
 * - paths relative to cwd
 * - paths relative to this file
 * - paths like uploads/xxx.png
 * - paths under backend1/uploads
 */
function resolveInputFilePath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return null;

  const candidates = [];

  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  } else {
    candidates.push(
      path.resolve(PROJECT_ROOT, normalized),
      path.resolve(__dirname, normalized),
      path.resolve(PROJECT_ROOT, "backend1", normalized),
      path.resolve(PROJECT_ROOT, "backend", normalized),
      path.resolve(PROJECT_ROOT, "uploads", path.basename(normalized)),
      path.resolve(PROJECT_ROOT, "backend1", "uploads", path.basename(normalized))
    );
  }

  for (const candidate of uniq(candidates)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Vision + text model call
 */
async function callVisionModel({ filePath, fileType, userMessage }) {
  const baseName = path.basename(filePath);
  const visionModel = VISION_MODEL || process.env.VISION_MODEL || "gpt-4o-mini";

  const systemPrompt = `
You are a general-purpose AI assistant that helps a software planning agent
understand arbitrary files provided by a user.

The user is building or modifying software and has provided one or more files
(designs, screenshots, PDFs, code snippets, logs, documents, etc).

For this specific file, do the following:

1) Identify what this file most likely is
   (e.g. ui_design, code, log, document, data, diagram, other).

2) Provide a concise natural-language summary of its content and purpose
   (2-6 sentences, max ~150 words).

3) Extract any information that would be useful for:
   - understanding user intent,
   - inferring required features or APIs,
   - understanding data structures or UI layout,
   - understanding constraints, edge cases, or system behavior.

Return your answer in EXACTLY this JSON format (no extra text):

{
  "file": "${baseName}",
  "fileType": "${fileType}",
  "natural_summary": "<2-6 sentences>",
  "structured": {
    "detected_kind": "<ui_design | code | doc | log | data | screenshot | diagram | other>",
    "key_elements": ["...", "..."],
    "possible_tasks": ["...", "..."],
    "domain_entities": ["...", "..."]
  }
}
`.trim();

  // Images: multimodal
  if (fileType === "image") {
    const imgBytes = await fs.promises.readFile(filePath);
    const base64 = imgBytes.toString("base64");
    const mime = guessImageMimeType(filePath);

    const userPrompt = `
User message (if any):
${userMessage || "(none)"}

Analyze the attached image file and respond according to the system instructions.
`.trim();

    const res = await openai.chat.completions.create({
      model: visionModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${base64}`,
              },
            },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    const raw = res.choices?.[0]?.message?.content?.trim() || "{}";
    return safeParseVisionJson(raw, { baseName, fileType });
  }

  // Text / code / pdf: snippet-based prompt
  const fileContentSnippet = await readFileSnippet(filePath, 4000);

  const userPrompt = `
User message (if any):
${userMessage || "(none)"}

File name: ${baseName}
File type guess: ${fileType}

File content (snippet, may be truncated):
"""
${fileContentSnippet}
"""
`.trim();

  const res = await openai.chat.completions.create({
    model: visionModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 800,
  });

  const raw = res.choices?.[0]?.message?.content?.trim() || "{}";
  return safeParseVisionJson(raw, { baseName, fileType });
}

/**
 * اگر مدل JSON دقیق نداد، این تابع سعی می‌کند parse کند یا fallback بسازد.
 */
function safeParseVisionJson(raw, { baseName, fileType }) {
  try {
    const trimmed = String(raw || "").trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const jsonStr = trimmed.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);

      return {
        file: parsed.file || baseName,
        fileType: parsed.fileType || fileType,
        natural_summary: parsed.natural_summary || trimmed,
        structured: parsed.structured || {
          detected_kind: "other",
          key_elements: [],
          possible_tasks: [],
          domain_entities: [],
        },
      };
    }
  } catch {
    // ignore and fall back
  }

  return {
    file: baseName,
    fileType,
    natural_summary: String(raw || "").trim(),
    structured: {
      detected_kind: "other",
      key_elements: [],
      possible_tasks: [],
      domain_entities: [],
    },
  };
}

/**
 * حداکثر N کاراکتر از فایل text/code/pdf می‌خوانیم (برای prompt)
 */
async function readFileSnippet(filePath, maxChars = 4000) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) return "(empty file)";

    const fd = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, maxChars));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    await fd.close();

    return buffer.toString("utf8", 0, bytesRead);
  } catch (e) {
    return `(failed to read file content: ${e.message})`;
  }
}

async function analyzeOneFile(filePath, userMessage) {
  const resolved = resolveInputFilePath(filePath);

  if (!resolved) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileType = detectFileType(resolved);

  return callVisionModel({
    filePath: resolved,
    fileType,
    userMessage,
  });
}

function parseInputArg(argRaw) {
  const raw = String(argRaw || "").trim();
  if (!raw) {
    return { files: [], userMessage: "" };
  }

  // If the CLI gets a JSON blob
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);

      const files = Array.isArray(parsed.files)
        ? parsed.files
        : Array.isArray(parsed.attachment_paths)
          ? parsed.attachment_paths
          : typeof parsed.file === "string"
            ? [parsed.file]
            : [];

      return {
        files: files.map((item) => String(item || "").trim()).filter(Boolean),
        userMessage: String(parsed.userMessage || parsed.message || "").trim(),
      };
    } catch {
      // fall through to raw string handling
    }
  }

  // Fallback: treat raw as a single file path
  return {
    files: [raw],
    userMessage: String(process.env.USER_MESSAGE || "").trim(),
  };
}

async function main() {
  try {
    const arg = process.argv[2] || "";

    if (!arg) {
      console.error(
        "file_agent.mjs requires input. Use either:\n" +
          '  node file_agent.mjs \'{"files":["uploads/a.png"],"userMessage":"..."}\'\n' +
          "or pass a single file path."
      );
      process.exit(1);
    }

    const { files, userMessage } = parseInputArg(arg);

    if (files.length === 0) {
      console.error("No files provided to file_agent.mjs");
      process.exit(1);
    }

    const results = [];

    console.log("FILE AGENT STARTED");
    console.log("cwd:", process.cwd());
    console.log("file agent url:", import.meta.url);
    console.log("input files:", files);
    console.log("user message:", userMessage || "(none)");

    for (const filePath of files) {
      try {
        const analysis = await analyzeOneFile(filePath, userMessage);
        results.push(analysis);
      } catch (e) {
        console.error(`❌ Failed to analyze file ${filePath}: ${e.message || e}`);
      }
    }

    if (results.length === 0) {
      console.error("No file could be analyzed");
      process.exit(1);
    }

    // Human-readable + structured JSON for planner
    let textOut = "";

    for (const r of results) {
      textOut += `File: ${r.file}\n`;
      textOut += `Type: ${r.fileType}\n`;
      textOut += `Summary: ${r.natural_summary}\n`;
      textOut += "\n";
    }

    const jsonOut = {
      files: results,
    };

    textOut += "[Structured_File_Analysis_JSON]\n";
    textOut += JSON.stringify(jsonOut, null, 2);

    process.stdout.write(textOut.trim() + "\n");
    process.exit(0);
  } catch (err) {
    console.error("file_agent.mjs error:", err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}