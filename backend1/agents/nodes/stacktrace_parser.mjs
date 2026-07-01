/**
 * stacktrace_parser.mjs
 * Extracts file paths and symbol names from stack traces and bug reports.
 */

function stripConversationMemory(text) {
  return String(text || "").split(/conversation memory:/i)[0].trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractFilePaths(message) {
  const files = [];
  const text = stripConversationMemory(message);

  const patterns = [
    /\b([\w\-./]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g,
    /\b([\w\-./]+\.(?:json|md|css|scss|yml|yaml|html|xml))\b/g,
    /\bat\s+\S+\s+\(([^)]+)\)/g,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const raw = String(match[1] || match[0]).trim();
      const cleaned = raw
        .replace(/:\d+:\d+$/, "")
        .replace(/:\d+$/, "")
        .replace(/^\.\//, "")
        .replace(/^\((.*)\)$/, "$1")
        .trim();

      if (cleaned.includes(".")) {
        files.push(cleaned);
      }
    }
  }

  return unique(files);
}

function extractSymbols(message) {
  const text = stripConversationMemory(message);
  const symbols = [];

  const identifierRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\b/g;
  let match;
  while ((match = identifierRe.exec(text)) !== null) {
    const id = match[1];
    if (
      /^(error|true|false|null|undefined|const|function|return|import|export|async|await|from|this|class|new|type|interface|string|number|boolean|object|void|any|json|stack|trace|bad|request)$/i.test(
        id
      )
    ) {
      continue;
    }
    symbols.push(id);
  }

  return unique(symbols).sort((a, b) => b.length - a.length).slice(0, 12);
}

export async function stacktraceParserNode(state) {
  const message = String(state.userMessage || "");
  const stackTraceFiles = extractFilePaths(message);
  const stackTraceSymbols = extractSymbols(message);

  return {
    stackTraceFiles,
    stackTraceSymbols,
    messages: [
      ...(state.messages || []),
      {
        role: "system",
        content: `Stack trace parsed: ${stackTraceFiles.length} file(s), ${stackTraceSymbols.length} symbol(s)`,
      },
    ],
  };
}