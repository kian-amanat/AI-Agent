import {
  containsWord,
  detectLanguage,
  detectProjectScope,
  detectRequestMode,
  detectTaskType,
  extractCandidateFilePaths,
  hasWorkspaceReference,
  isCrisis,
  isGreeting,
  isTechnicalRequest,
  isVagueRequest,
  isWorkspaceCodeRequest,
  isWorkspaceInspectionRequest,
  isWorkspaceModificationRequest,
  wantsBuildFromAttachment,
} from "../utils/text.util.mjs";

export function classifyIntent(message, attachments = []) {
  const msg = String(message || "").toLowerCase();
  const hasAttachments = attachments.length > 0;

  if (isCrisis(message)) return { type: "crisis", confidence: 1 };
  if (isGreeting(message)) return { type: "greeting", confidence: 1 };

  if (
    wantsBuildFromAttachment(message, attachments) ||
    isWorkspaceModificationRequest(message)
  ) {
    return { type: "technical", confidence: 0.98 };
  }

  if (isWorkspaceCodeRequest(message)) {
    return { type: "code_request", confidence: 1 };
  }

  if (
    (isWorkspaceInspectionRequest(message) || hasAttachments) &&
    !wantsBuildFromAttachment(message, attachments)
  ) {
    if (/code|read|inspect|open|show|full file|full code|content/.test(msg)) {
      return { type: "code_request", confidence: 1 };
    }
    return { type: "inspection", confidence: 1 };
  }

  const technicalKeywords = [
    "api",
    "backend",
    "frontend",
    "database",
    "auth",
    "dashboard",
    "react",
    "vue",
    "node",
    "fastify",
    "express",
    "postgresql",
    "mongodb",
    "microservice",
    "rest",
    "graphql",
    "websocket",
    "دیتابیس",
    "بک‌اند",
    "فرانت‌اند",
    "داشبورد",
    "احراز هویت",
    "page.tsx",
    "layout.tsx",
    "globals.css",
    "component",
    "file",
    "code",
    "design",
    "style",
    "match",
    "sync",
    "access",
    "inspect",
    "read",
    "login page",
    "sidebar",
    "chatbot",
    "folder",
    "directory",
    "upload",
    "image",
    "screenshot",
    "file input",
    "attachment",
  ];

  const hasTechnicalKeyword = technicalKeywords.some((kw) => msg.includes(kw));

  const vaguePatterns = [
    /create\s+(a\s+)?dashboard/i,
    /build\s+(a\s+)?website/i,
    /make\s+(an?\s+)?app/i,
    /develop\s+(a\s+)?system/i,
    /بساز\s+داشبورد/i,
    /بساز\s+وب‌سایت/i,
    /بساز\s+اپلیکیشن/i,
  ];

  const isVague = vaguePatterns.some((pattern) => pattern.test(message));

  if (isVague && !hasTechnicalKeyword) return { type: "clarification", confidence: 0.8 };
  if (hasTechnicalKeyword || msg.split(/\s+/).length > 10) return { type: "technical", confidence: 0.9 };

  if (msg.length < 15 || msg.split(/\s+/).length < 4) {
    return { type: "casual", confidence: 0.9 };
  }

  return { type: "casual", confidence: 0.7 };
}

export {
  detectLanguage,
  isCrisis,
  isGreeting,
  isTechnicalRequest,
  isVagueRequest,
  isWorkspaceCodeRequest,
  isWorkspaceInspectionRequest,
  isWorkspaceModificationRequest,
  wantsBuildFromAttachment,
  hasWorkspaceReference,
  extractCandidateFilePaths,
  detectRequestMode,
  detectTaskType,
  detectProjectScope,
  containsWord,
};