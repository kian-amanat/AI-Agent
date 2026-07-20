import OpenAI from "openai";

import { readProjectFile } from "./tools/readProjectFile.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { grepCode } from "./tools/grep_code.js";

const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  "***REMOVED-SECRET***";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const DESIGN_REFERENCE_FILENAMES = [
  "page.tsx",
  "layout.tsx",
  "globals.css",
  "page.jsx",
  "layout.jsx",
  "globals.scss",
  "globals.sass",
  "globals.less",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read ANY project file. Use this whenever the user references a file name such as page.tsx, layout.tsx, globals.css, package.json, component files, API routes, or asks about existing code.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
          },
          startLine: {
            type: "number",
          },
          endLine: {
            type: "number",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "Browse the workspace and locate files. Use this before saying a file cannot be found.",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_code",
      description:
        "Search the entire project for filenames, components, functions, classes, imports, routes, and code patterns.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_file",
      description:
        "Find files by filename anywhere in the project. Use this when the user mentions a filename like page.tsx, layout.tsx, globals.css, Sidebar.tsx, LoginPage.tsx, or any file name without a full path.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
          },
          dir: {
            type: "string",
          },
        },
        required: ["filename"],
      },
    },
  },
];

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function collectFilenameHints(userMessage) {
  const msg = String(userMessage || "");

  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
    /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = uniq([
    ...(msg.match(pathRegex) || []),
    ...(msg.match(filenameRegex) || []),
  ]);

  return matches.map(normalizePath);
}

async function getAllProjectFiles(dir = "") {
  const result = await listBackendFiles({
    dir,
    maxDepth: 12,
    includeMeta: true,
    includeFiles: true,
    includeDirs: false,
  });

  if (!result?.success || !Array.isArray(result.files)) {
    return [];
  }

  return result.files
    .filter((f) => !f.is_dir)
    .map((f) => normalizePath(f.path));
}

async function findFile(filename, { dir = "", limit = 20 } = {}) {
  const target = String(filename || "").trim().toLowerCase();
  if (!target) return [];

  const files = await getAllProjectFiles(dir);
  const scored = files
    .map((filePath) => {
      const base = filePath.split("/").pop()?.toLowerCase() || "";
      const score =
        base === target
          ? 100
          : base.endsWith(target)
          ? 85
          : base.includes(target)
          ? 70
          : 0;

      return { filePath, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.filePath);

  return uniq(scored);
}

async function executeToolCall(toolCall) {
  const fn = toolCall.function.name;

  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = {};
  }

  switch (fn) {
    case "read_file":
      return await readProjectFile({
        path: args.path,
        startLine: args.startLine,
        endLine: args.endLine,
      });

    case "list_files":
      return await listBackendFiles({
        dir: args.dir || "",
      });

    case "grep_code":
      return await grepCode(args);

    case "find_file":
      return {
        success: true,
        files: await findFile(args.filename, {
          dir: args.dir || "",
          limit: args.limit || 20,
        }),
      };

    default:
      return {
        success: false,
        error: `Unknown tool: ${fn}`,
      };
  }
}

async function collectDesignSourceFiles(userMessage) {
  const hints = uniq([
    ...DESIGN_REFERENCE_FILENAMES,
    ...collectFilenameHints(userMessage),
  ]);

  const candidates = [];

  for (const hint of hints) {
    const matches = await findFile(hint, { limit: 5 });
    for (const file of matches) {
      candidates.push(file);
    }
  }

  return uniq(candidates);
}

async function getDesignSystem(userMessage = "") {
  try {
    const files = await collectDesignSourceFiles(userMessage);

    if (!files.length) {
      return null;
    }

    const snippets = [];

    for (const file of files.slice(0, 8)) {
      const res = await readProjectFile({
        path: file,
        maxBytes: 140000,
      });

      if (res?.success && res.content) {
        snippets.push({
          path: file,
          content: String(res.content).slice(0, 6000),
        });
      }
    }

    if (!snippets.length) {
      return null;
    }

console.log({
  promptChars: prompt.length,
  workspaceChars: workspaceContext.length,
  currentChars: currentContent.length,
  globalContextChars: JSON.stringify(globalSmartContext).length,
  fileContextChars: JSON.stringify(fileSmartContext).length,
});

    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
You are a UI design system extractor.

Extract the visual design system from the provided project files.

Return ONLY valid JSON with this schema:
{
  "theme": "dark" | "light" | "mixed" | "unknown",
  "colors": {
    "background": [],
    "surface": [],
    "border": [],
    "text": [],
    "accent": [],
    "muted": []
  },
  "shadows": [],
  "radius": [],
  "spacing": [],
  "typography": [],
  "buttons": [],
  "inputs": [],
  "cards": [],
  "animations": [],
  "notes": []
}

Rules:
- Be faithful to the code.
- Do not invent styles.
- If a value is not clearly present, omit it.
- Return JSON only.
          `.trim(),
        },
        {
          role: "user",
          content: snippets
            .map((item) => `FILE: ${item.path}\n${item.content}`)
            .join("\n\n---\n\n"),
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(raw);

    if (parsed.ok) {
      return parsed.value;
    }

    return {
      theme: "unknown",
      notes: ["Could not parse design system JSON."],
      raw: raw.slice(0, 5000),
    };
  } catch {
    return null;
  }
}

async function preloadReferencedFiles(userMessage) {
  const hints = collectFilenameHints(userMessage);
  const shouldAddDesignRefs =
    /design|style|theme|login|chatbot|sidebar|layout|page|colors|ui/i.test(
      userMessage || ""
    );

  const candidateNames = uniq([
    ...hints,
    ...(shouldAddDesignRefs ? DESIGN_REFERENCE_FILENAMES : []),
  ]);

  const loaded = [];
  const seen = new Set();

  for (const name of candidateNames) {
    const matches = await findFile(name, { limit: 3 });

    for (const file of matches) {
      if (seen.has(file)) continue;
      seen.add(file);

      const res = await readProjectFile({
        path: file,
        maxBytes: 160000,
      });

      if (res?.success && res.content) {
        loaded.push({
          path: file,
          content: String(res.content).slice(0, 12000),
        });
      }

      if (loaded.length >= 6) break;
    }

    if (loaded.length >= 6) break;
  }

  return loaded;
}

function buildSystemPrompt(designSystem, loadedFilesText) {
  return `
You are an advanced autonomous software engineering agent.

You have direct access to the user's project through tools.

AVAILABLE TOOLS:
- read_file(path)
- list_files(dir)
- grep_code(query)
- find_file(filename)

IMPORTANT:

The user may reference files that are not pasted into chat.

When the user asks questions such as:

- "Do you have access to page.tsx?"
- "Read login page"
- "Check sidebar component"
- "Update dashboard layout"
- "Make login page match chatbot page"
- "Use the same colors as page.tsx"

You MUST NOT answer:
"I don't have access to that file."

Instead:

1. Use find_file, list_files, and/or grep_code to locate the file.
2. Use read_file to inspect the file.
3. Analyze the actual source code.
4. Then answer based on the file contents.

You have permission to inspect any file inside the workspace.

Never claim a file is inaccessible unless:
- read_file fails
- list_files and find_file cannot locate it

If a user references a filename like page.tsx, layout.tsx, globals.css, login.tsx, Sidebar.tsx, or similar, always attempt to locate it first.

If relevant files were already preloaded into context, use them directly.

DESIGN SYSTEM RULES:

You MUST follow the design system exactly if one is provided.

Design System:
${designSystem ? JSON.stringify(designSystem, null, 2) : "NOT FOUND"}

Loaded project files:
${loadedFilesText || "NONE"}

Rules:
- Match UI colors exactly from design system.
- Do NOT invent new colors if a design system exists.
- Use the same spacing scale.
- Use the same typography.
- Use the same border radius.
- Use the same shadows.
- Use the same gradients.
- Use the same button styles.
- Login page MUST visually match chatbot UI.
- Prefer reusing existing patterns over creating new ones.

CODE ANALYSIS RULES:

Before generating code:

1. Inspect relevant files.
2. Inspect imported components.
3. Inspect surrounding layout files.
4. Inspect styles and theme files.
5. Inspect dependencies.

Never assume implementation details.

Always gather context first.

WORKFLOW:

User request
→ discover files
→ read files
→ analyze architecture
→ generate solution

Do not skip the discovery step.
Do not skip file inspection.
Do not claim lack of access before using tools.
`.trim();
}

function buildLoadedFilesText(loadedFiles) {
  if (!Array.isArray(loadedFiles) || loadedFiles.length === 0) return "";

  return loadedFiles
    .map((item) => `FILE: ${item.path}\n${item.content}`)
    .join("\n\n---\n\n");
}

function shouldForceFileInspection(userMessage) {
  return /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/i.test(
    userMessage || ""
  );
}

export async function runAgentRuntime(userMessage) {
  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    throw new Error("userMessage is required");
  }

  const designSystem = await getDesignSystem(userMessage);
  const preloadedFiles = await preloadReferencedFiles(userMessage);
  const loadedFilesText = buildLoadedFilesText(preloadedFiles);

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(designSystem, loadedFilesText),
    },
  ];

  if (loadedFilesText) {
    messages.push({
      role: "system",
      content: `
The following project files have already been discovered and loaded into context.
Use them directly. Do not claim you cannot access them.

${loadedFilesText}
      `.trim(),
    });
  }

  messages.push({
    role: "user",
    content: userMessage,
  });
console.log({
  promptChars: prompt.length,
  workspaceChars: workspaceContext.length,
  currentChars: currentContent.length,
  globalContextChars: JSON.stringify(globalSmartContext).length,
  fileContextChars: JSON.stringify(fileSmartContext).length,
});
  for (let step = 0; step < 15; step++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.1,
    });

    const msg = response.choices?.[0]?.message;

    if (!msg) {
      throw new Error("No message returned by model");
    }

    if (!msg.tool_calls?.length) {
      const content = msg.content || "";

      if (
        shouldForceFileInspection(userMessage) &&
        /don't have access|do not have access|I don’t have access|I don't have access/i.test(
          content
        )
      ) {
        messages.push({
          role: "user",
          content:
            "You already have project-file access through tools and preloaded context. Do not claim lack of access. Use the relevant file context or call tools now.",
        });
        continue;
      }

      return content;
    }

    messages.push(msg);

    for (const toolCall of msg.tool_calls) {
      const result = await executeToolCall(toolCall);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("Agent exceeded max reasoning steps");
}