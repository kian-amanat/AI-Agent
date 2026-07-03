/**
 * services/agentMemory.mjs
 * File-based persistent memory: {workspace}/.kodo/memory/
 *
 * Layout:
 *   MEMORY.md            — index (≤200 lines), loaded into every request
 *   project-context.md   — project stack, architecture, directory layout
 *   user-preferences.md  — how the user wants things done
 *   code-patterns.md     — recurring patterns in this codebase
 *   debugging-history.md — bugs found + root causes
 *   ...                  — any topic the LLM decides to create
 *
 * Workflow:
 *  1. On every request → loadMemoryIndex() → injected into agent context
 *  2. Explore node → read_memory_topic(topic) tool → agentic retrieval
 *  3. After successful graph run → writeAgentMemory() → fire-and-forget
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { callLLM } from "./llm.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// Fallback root: two levels up from services/ → ai-sandbox/
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const MEMORY_DIR   = ".kodo/memory";
const INDEX_FILE   = "MEMORY.md";
const MAX_INDEX_LINES  = 200;
const MAX_TOPIC_CHARS  = 4000;

// ── Path helpers ──────────────────────────────────────────────────────────────

function resolveRoot(workspacePath) {
  return workspacePath || PROJECT_ROOT;
}

export function getMemoryDir(workspacePath) {
  return path.join(resolveRoot(workspacePath), MEMORY_DIR);
}

async function ensureMemoryDir(workspacePath) {
  const dir = getMemoryDir(workspacePath);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function toSafeName(name) {
  return String(name || "")
    .replace(/[^a-z0-9-_]/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "memory";
}

// ── Read + topic utilities ────────────────────────────────────────────────────

/**
 * Returns first 200 lines of MEMORY.md, or "" if none exists.
 * This is injected into every agent request automatically.
 */
export async function loadMemoryIndex(workspacePath) {
  const dir = getMemoryDir(workspacePath);
  if (!dir) return "";
  try {
    const raw = await fs.readFile(path.join(dir, INDEX_FILE), "utf-8");
    return raw.split("\n").slice(0, MAX_INDEX_LINES).join("\n");
  } catch {
    return "";
  }
}

/**
 * Read a specific topic file on demand. Returns null if not found.
 * Called by the read_memory_topic tool during exploration.
 */
export async function readMemoryTopic(workspacePath, topicName) {
  const dir = getMemoryDir(workspacePath);
  if (!dir || !topicName) return null;
  try {
    return await fs.readFile(path.join(dir, `${toSafeName(topicName)}.md`), "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all topic names in the memory directory.
 * Called by the list_memory_topics tool.
 */
export async function listMemoryTopics(workspacePath) {
  const dir = getMemoryDir(workspacePath);
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter(f => f.endsWith(".md") && f !== INDEX_FILE)
      .map(f => f.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Load topic files whose names/descriptions match keywords in the user message.
 * Called by the answer node before generating a response.
 * Returns { topicName: fileContent, ... } for matched topics (up to 4).
 */
export async function loadRelevantTopics(workspacePath, cleanUserMessage) {
  const index = await loadMemoryIndex(workspacePath);
  if (!index) return {};

  const words = new Set(
    String(cleanUserMessage || "")
      .toLowerCase()
      .split(/[\s,;:!?.'"()\[\]{}]+/)
      .filter(w => w.length > 3)
  );
  if (words.size === 0) return {};

  const results = {};
  for (const line of index.split("\n")) {
    const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/);
    if (!m) continue;
    const [, name, , description] = m;
    const topicText = `${name} ${description}`.toLowerCase();
    const matchCount = [...words].filter(w => topicText.includes(w)).length;
    if (matchCount > 0) {
      const content = await readMemoryTopic(workspacePath, name);
      if (content) results[name] = content;
    }
    if (Object.keys(results).length >= 4) break;
  }
  return results;
}

/**
 * Delete a specific topic file and remove its entry from MEMORY.md.
 * Used by forget-command handling in the answer node.
 */
export async function deleteMemoryTopic(workspacePath, topicName) {
  const dir = getMemoryDir(workspacePath);
  const safe = toSafeName(topicName);

  try { await fs.unlink(path.join(dir, `${safe}.md`)); } catch {}

  let existing = "";
  try { existing = await fs.readFile(path.join(dir, INDEX_FILE), "utf-8"); } catch { return; }

  const filtered = existing
    .split("\n")
    .filter(l => !l.includes(`[${safe}]`))
    .join("\n");
  await fs.writeFile(path.join(dir, INDEX_FILE), filtered, "utf-8");
  console.log(`[AgentMemory] 🗑️  Deleted topic: ${safe}`);
}

/**
 * Delete all memory files (MEMORY.md + all topic files).
 */
export async function clearAllMemory(workspacePath) {
  const dir = getMemoryDir(workspacePath);
  try {
    const entries = await fs.readdir(dir);
    for (const f of entries) {
      if (f.endsWith(".md")) await fs.unlink(path.join(dir, f)).catch(() => {});
    }
    console.log("[AgentMemory] 🗑️  All memory cleared");
  } catch {}
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function writeTopicFile(dir, name, content) {
  const now = new Date().toISOString();
  // Strip any existing front-matter before writing so it never doubles up
  const stripped = String(content).replace(/^---[\s\S]*?---\n+/, "").trimStart();
  const body = `---\nupdated: ${now}\n---\n\n${stripped}`;
  await fs.writeFile(path.join(dir, `${toSafeName(name)}.md`), body, "utf-8");
}

async function updateIndex(dir, entries) {
  let existing = "";
  try { existing = await fs.readFile(path.join(dir, INDEX_FILE), "utf-8"); } catch {}

  // Parse existing entries into a map (name → { file, desc })
  const map = new Map();
  for (const line of existing.split("\n")) {
    const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/);
    if (m) map.set(m[1], { file: m[2], desc: m[3] });
  }

  // Merge new/updated entries
  for (const e of entries) {
    if (!e?.name) continue;
    const safe = toSafeName(e.name);
    map.set(safe, { file: `${safe}.md`, desc: String(e.description || e.name).slice(0, 100) });
  }

  const lines = ["# Kodo Memory Index", ""];
  for (const [name, { file, desc }] of map) {
    lines.push(`- [${name}](${file}) — ${desc}`);
  }

  await fs.writeFile(path.join(dir, INDEX_FILE), lines.join("\n") + "\n", "utf-8");
}

// ── LLM-driven writer ─────────────────────────────────────────────────────────

const WRITER_SYSTEM = `You are Kodo's memory curator. After each conversation, decide what facts are worth persisting across sessions.

WHAT TO SAVE:
- Project stack, architecture, directory structure → topic: "project-context"
- User preferences, corrections, desired style → topic: "user-preferences"
- Recurring code patterns (component structure, state names, imports) → topic: "code-patterns"
- Bugs found + root causes → topic: "debugging-history"
- Create other topics if clearly useful

WHAT NOT TO SAVE:
- The conversation transcript or ephemeral task details
- Anything obvious from reading the current code
- Sensitive values (API keys, passwords)

MERGE RULES:
- Your "content" field REPLACES the existing topic file — merge old facts with new ones
- Keep each topic concise: bullet points, ≤30 lines
- Remove facts that are clearly stale or wrong

Return ONLY valid JSON:
{
  "topics": [
    {
      "name": "code-patterns",
      "description": "One-line summary for the index (≤80 chars)",
      "content": "Full markdown content for this topic (merged old + new facts)"
    }
  ]
}

If nothing new is worth saving: { "topics": [] }`;

function buildWriterPrompt({ userMessage, assistantAnswer, editedFiles, existingIndex, existingTopics }) {
  const fileSection = editedFiles.length
    ? `Files edited this turn:\n${editedFiles.map(f => `  - ${f}`).join("\n")}`
    : "No files were edited (Q&A only).";

  const topicsSection = Object.entries(existingTopics).length
    ? Object.entries(existingTopics)
        .map(([name, content]) => `=== ${name}.md ===\n${String(content).slice(0, 1200)}`)
        .join("\n\n")
    : "(no existing topics)";

  return `INTERACTION SUMMARY
User: "${String(userMessage).slice(0, 500)}"
Response: "${String(assistantAnswer).slice(0, 500)}"
${fileSection}

EXISTING MEMORY INDEX:
${existingIndex || "(empty)"}

EXISTING TOPIC FILES:
${topicsSection}

Decide what (if anything) is worth persisting. Return JSON.`;
}

function extractJSON(text) {
  const raw = String(text || "").trim();
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}

/**
 * Main entry point — called fire-and-forget after each graph run.
 * Uses the LLM to decide what (if anything) is worth saving.
 */
// Serialize all memory writes — prevents concurrent requests corrupting topic files
let _writeQueue = Promise.resolve();

export async function writeAgentMemory({ workspacePath, userMessage, assistantAnswer, editedFiles = [], modelRoute }) {
  // workspacePath may be empty — resolveRoot() falls back to PROJECT_ROOT
  const effectiveRoot = resolveRoot(workspacePath);
  console.log(`[AgentMemory] Writing memory → ${effectiveRoot}/.kodo/memory/`);
  // Chain onto the queue so concurrent calls run one-at-a-time
  _writeQueue = _writeQueue.then(() => _doWrite({ workspacePath, userMessage, assistantAnswer, editedFiles, modelRoute })).catch(() => {});
  return _writeQueue;
}

async function _doWrite({ workspacePath, userMessage, assistantAnswer, editedFiles = [], modelRoute }) {

  try {
    const existingIndex = await loadMemoryIndex(workspacePath);
    const topicNames    = await listMemoryTopics(workspacePath);

    // Load existing topic content so the LLM can merge intelligently
    const existingTopics = {};
    for (const name of topicNames.slice(0, 6)) {
      const content = await readMemoryTopic(workspacePath, name);
      if (content) existingTopics[name] = content;
    }

    const result = await callLLM({
      system: WRITER_SYSTEM,
      messages: [{
        role: "user",
        content: buildWriterPrompt({ userMessage, assistantAnswer, editedFiles, existingIndex, existingTopics }),
      }],
      modelRoute,
      maxTokens: 2000,
      temperature: 0.1,
    });

    const parsed = extractJSON(result?.content || "");
    if (!Array.isArray(parsed?.topics) || parsed.topics.length === 0) {
      console.log("[AgentMemory] Nothing to save this turn.");
      return;
    }

    const dir = await ensureMemoryDir(workspacePath);
    if (!dir) return;

    const saved = [];
    for (const topic of parsed.topics) {
      if (!topic?.name || !topic?.content) continue;
      await writeTopicFile(dir, topic.name, String(topic.content).slice(0, MAX_TOPIC_CHARS));
      saved.push({ name: topic.name, description: topic.description || topic.name });
      console.log(`[AgentMemory] ✏️  Saved topic: ${topic.name}`);
    }

    if (saved.length > 0) {
      await updateIndex(dir, saved);
      console.log(`[AgentMemory] ✅ Updated MEMORY.md — ${saved.length} topic(s)`);
    }
  } catch (err) {
    console.warn("[AgentMemory] write failed (non-fatal):", err.message);
  }
}
