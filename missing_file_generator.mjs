import fs from "fs";
import path from "path";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

function clean(text) {
  if (!text) return "";

  return text
    .replace(/```[a-zA-Z]*/g, "")
.replace(/```/g, "")
    .trim();
}

function extractMissingModules(tscOutput) {
  const regex = /Cannot find module '(.+?)'/g;

  const modules = [];

  let match;

  while ((match = regex.exec(tscOutput)) !== null) {
    modules.push(match[1]);
  }

  return modules;
}

function resolveModule(projectDir, fromFile, importPath) {
  if (!importPath.startsWith(".")) return null;

  const base = path.dirname(path.join(projectDir, fromFile));

  let full = path.resolve(base, importPath);

  if (!full.endsWith(".ts")) {
    full += ".ts";
  }

  return full;
}

async function generateFile(filePath, projectContext) {
  console.log(`🧠 Generating missing file: ${filePath}`);

  const prompt = `
You are generating a missing file for a TypeScript backend project.

Stack:
Node.js
TypeScript
Fastify
Drizzle ORM
SQLite
Vitest
bcrypt

Project context:
${projectContext}

File path:
${filePath}

Rules:
- ESM modules
- correct TypeScript
- minimal but working implementation
- export necessary functions/classes

Return FULL file.
No markdown.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You generate backend TypeScript files.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const code = clean(resp.choices[0].message.content);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(filePath, code);
}

export async function generateMissingFiles(projectDir, tscOutput, projectContext) {
  const modules = extractMissingModules(tscOutput);

  if (!modules.length) return;

  console.log("🔎 Missing modules detected:", modules);

  const lines = tscOutput.split("\n");

  for (const line of lines) {
    const fileMatch = line.match(/^(.+\.ts)\(/);

    if (!fileMatch) continue;

    const sourceFile = fileMatch[1];

    for (const mod of modules) {
      const resolved = resolveModule(projectDir, sourceFile, mod);

      if (!resolved) continue;

      if (fs.existsSync(resolved)) continue;

      await generateFile(resolved, projectContext);
    }
  }
}
