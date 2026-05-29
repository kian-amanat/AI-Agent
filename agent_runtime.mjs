import OpenAI from "openai";

import { readProjectFile } from "./tools/readProjectFile.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { grepCode } from "./tools/grep_code.js";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "***REMOVED-SECRET***";

const client = new OpenAI({
  apiKey:  OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const MODEL = "gpt-4.1";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the workspace",
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
        "List files and folders in project",
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
        "Search code patterns in project",
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
];

async function executeToolCall(toolCall) {
  const fn = toolCall.function.name;

  const args = JSON.parse(
    toolCall.function.arguments || "{}"
  );

  switch (fn) {
    case "read_file":
      return await readProjectFile(args);

    case "list_files":
      return await listBackendFiles(args);

    case "grep_code":
      return await grepCode(args);

    default:
      return {
        success: false,
        error: `Unknown tool: ${fn}`,
      };
  }
}

export async function runAgentRuntime(
  userMessage
) {
  const messages = [
    {
      role: "system",
      content: `
You are an advanced software engineering agent.

Your job:
- inspect project
- read files
- analyze dependencies
- search code
- understand architecture
- then implement changes

IMPORTANT:
- Always inspect code before generating.
- Use tools aggressively.
- Never assume file contents.
- Read relevant files first.
      `,
    },

    {
      role: "user",
      content: userMessage,
    },
  ];

  for (let step = 0; step < 15; step++) {
    console.log(
      `\n🧠 Agent reasoning step ${step + 1}`
    );

    const response =
      await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.1,
      });

    const msg = response.choices[0].message;

    // اگر AI جواب نهایی داد
    if (!msg.tool_calls?.length) {
      console.log("\n✅ Final Response:\n");
      console.log(msg.content);

      return msg.content;
    }

    messages.push(msg);

    // اجرای tool calls
    for (const toolCall of msg.tool_calls) {
      console.log(
        `\n🔧 Tool Call: ${toolCall.function.name}`
      );

      const result = await executeToolCall(
        toolCall
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error(
    "Agent exceeded max reasoning steps"
  );
}