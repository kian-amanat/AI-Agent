/**
 * app/lib/api.ts — UPDATED for LangGraph
 *
 * Only the SSEEvent type and parseSSE are changed.
 * Everything else (auth, sessions, upload, settings) is identical.
 */

const BASE_URL        = "http://localhost:9000/api/agent";
const UPLOAD_URL      = `${BASE_URL}/upload`;
const TRANSCRIBE_URL  = `${BASE_URL}/transcribe`;
const SETTINGS_URL    = "http://localhost:9000/api/settings";
const AUTH_URL        = "http://localhost:9000/api/auth";
const WORKSPACE_URL   = "http://localhost:9000/api/workspace";

export interface Session {
  id:            string;
  title:         string | null;
  created_at:    string;
  updated_at:    string;
  message_count: number;
}

export interface Message {
  id:         number;
  session_id: string;
  role:       "user" | "assistant";
  content:    string;
  intent:     string | null;
  created_at: string;
}

// ─── SSE event types (extended for LangGraph) ─────────────────

/** A single step in the agent's plan */
export interface PlanStep {
  action:      "edit" | "create" | "delete" | "read_only";
  path:        string;
  description: string;
}

/** A file loaded from the workspace */
export interface WorkspaceFile {
  path:    string;
  size:    number;
  summary: string;
}

export interface DiffHunk {
  kind: "replace" | "insert" | "delete" | "create" | "rewrite";
  before?: string;
  after?: string;
  anchor?: string;
}

export interface FileDiff {
  action: string;
  path: string;
  language: string;
  hunks: DiffHunk[];
}

export type SSEEvent =
  | { type: "start";        sessionId: string; requestId?: string; intent?: string | null }
  | { type: "content";      chunk: string }
  | { type: "done";         sessionId: string; requestId?: string | null }
  | { type: "progress";     stage?: string; message?: string }
  | { type: "plan_metadata"; raw: any }
  | { type: "plan";         reasoning: string; steps: PlanStep[]; message?: string }
  | { type: "file_context"; files: WorkspaceFile[] }
  | { type: "file_change";  action: string; path: string; success: boolean; error?: string | null }
  | { type: "file_diff";    action: string; path: string; language: string; hunks: DiffHunk[] }
  | { type: "plan_preview"; steps: PlanStep[] }
  | { type: "todo";         todos: TodoItem[] }
  | { type: "question";     questionId: string; question: string; header?: string; options?: QuestionOption[] }
  | { type: "usage";        inputTokens: number; outputTokens: number; llmCalls: number; model?: string };

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface QuestionOption {
  label:        string;
  description?: string;
}

export interface GitStatus {
  branch:            string;
  dirty:             boolean;
  uncommittedCount?: number;
  ahead:             number;
  hasUpstream?:      boolean;
  pullRequestUrl?:   string | null;
}

export interface WorkspaceFileEntry {
  path: string;
  type: "file" | "dir";
}

export type UndoStats = {
  total: number; restored: number; deleted: number; no_op: number; failed: number;
};
export type UndoFileResult = {
  file: string; action: string; reason?: string; error?: string;
};
export type UndoResult = {
  ok: boolean; session_id: string; request_id: string;
  result: { stats: UndoStats; files: UndoFileResult[] };
};

// ─── Helpers ──────────────────────────────────────────────────

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; }
  catch { throw new Error(text || res.statusText || "Invalid server response"); }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("kodo_token");
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ─── parseSSE (extended for LangGraph events) ─────────────────

async function parseSSE(
  res:               Response,
  onEvent:           (event: SSEEvent) => void,
  onDone:            (sessionId: string, requestId?: string | null) => void,
  onError:           (err: string) => void,
  fallbackSessionId: string | null
) {
  if (!res.body) { onError("No response body received"); return; }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer              = "";
  let returnedSessionId   = fallbackSessionId ?? "";
  let returnedRequestId: string | null = null;
  let receivedContent     = "";
  let streamCompleted     = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const raw = trimmed.slice(5).trim();
          if (!raw) continue;

          let parsed: any;
          try { parsed = JSON.parse(raw); }
          catch { onError("Malformed server event (invalid JSON)"); continue; }

          if (parsed?.session_id) returnedSessionId = String(parsed.session_id);
          if (parsed?.request_id) returnedRequestId = String(parsed.request_id);

          const type: string = parsed?.type || "";

          switch (type) {
            case "start":
              if (parsed.session_id) returnedSessionId = String(parsed.session_id);
              if (parsed.request_id) returnedRequestId = String(parsed.request_id);
              onEvent({
                type:      "start",
                sessionId: returnedSessionId,
                requestId: returnedRequestId ?? undefined,
                intent:    parsed.metadata?.intent ?? null,
              });
              break;

            case "content":
              if (typeof parsed.content === "string" && parsed.content) {
                receivedContent += parsed.content;
                onEvent({ type: "content", chunk: parsed.content });
              }
              break;

            case "progress":
              onEvent({ type: "progress", stage: parsed.stage, message: parsed.message });
              break;

            case "plan_metadata":
              onEvent({ type: "plan_metadata", raw: parsed });
              break;

            // ★ NEW: LangGraph plan event
            case "plan":
              onEvent({
                type:      "plan",
                reasoning: parsed.reasoning || "",
                steps:     Array.isArray(parsed.steps) ? parsed.steps : [],
                message:   parsed.message,
              });
              break;

            // ★ NEW: workspace files loaded
            case "file_context":
              onEvent({
                type:  "file_context",
                files: Array.isArray(parsed.files) ? parsed.files : [],
              });
              break;

            // ★ NEW: individual file written / created / deleted
            case "file_change":
              onEvent({
                type:    "file_change",
                action:  parsed.action  || "",
                path:    parsed.path    || "",
                success: Boolean(parsed.success),
                error:   parsed.error   || null,
              });
              break;

            case "file_diff":
              onEvent({
                type:     "file_diff",
                action:   parsed.action   || "",
                path:     parsed.path     || "",
                language: parsed.language || "",
                hunks:    Array.isArray(parsed.hunks) ? parsed.hunks : [],
              });
              break;

            case "plan_preview":
              onEvent({
                type:  "plan_preview",
                steps: Array.isArray(parsed.steps) ? parsed.steps : [],
              });
              break;

            // Agent todo list (Claude Code-style task tracking)
            case "todo":
              onEvent({
                type:  "todo",
                todos: Array.isArray(parsed.todos) ? parsed.todos : [],
              });
              break;

            // Agent is asking a clarifying question instead of guessing
            case "question":
              onEvent({
                type:       "question",
                questionId: String(parsed.questionId || ""),
                question:   String(parsed.question || ""),
                header:     parsed.header,
                options:    Array.isArray(parsed.options) ? parsed.options : [],
              });
              break;

            // Token usage for the request
            case "usage":
              onEvent({
                type: "usage",
                inputTokens:  Number(parsed.inputTokens)  || 0,
                outputTokens: Number(parsed.outputTokens) || 0,
                llmCalls:     Number(parsed.llmCalls)     || 0,
                model:        parsed.model,
              });
              break;

            case "done": {
              if (parsed.metadata?.request_id && !returnedRequestId) {
                returnedRequestId = String(parsed.metadata.request_id);
              }
              const finalSessionId = returnedSessionId || fallbackSessionId || "";
              streamCompleted = true;
              onEvent({ type: "done", sessionId: finalSessionId, requestId: returnedRequestId });
              onDone(finalSessionId, returnedRequestId);
              break;
            }

            case "error": {
              const msg = parsed.details || parsed.error || "Unknown error from server";
              onError(msg);
              throw new Error(msg);
            }
          }
        }
      }
    }

    if (!streamCompleted && returnedSessionId) onDone(returnedSessionId, returnedRequestId);
  } catch (err) {
    if (!streamCompleted && receivedContent.length > 0) {
      // Stream disconnected mid-response — surface partial content to the UI
      onError(`Connection lost mid-response (${receivedContent.length} chars received). Send your message again to retry.`);
    } else {
      onError(err instanceof Error ? err.message : "SSE error");
    }
  }
}

// ─── sendMessage (unchanged interface) ────────────────────────

type RunPayload = {
  message:          string;
  session_id?:      string;
  attachment_paths?: string[];
  permission_mode?: "auto" | "ask";
};

export function sendMessage(
  message:        string,
  file:           File | File[] | null,
  sessionId:      string | null,
  onEvent:        (event: SSEEvent) => void,
  onDone:         (sessionId: string, requestId?: string | null) => void,
  onError:        (err: string) => void,
  signal?:        AbortSignal,
  permissionMode: "auto" | "ask" = "auto"
): () => void {
  const controller = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  void (async () => {
    try {
      let attachmentPaths: string[] = [];
      const filesToUpload = Array.isArray(file) ? file.filter(Boolean) : file ? [file] : [];

      for (const f of filesToUpload) {
        const p = await uploadAttachment(f);
        if (p) attachmentPaths.push(p);
      }

      const payload: RunPayload = {
        message,
        ...(sessionId             ? { session_id:       sessionId      } : {}),
        ...(attachmentPaths.length ? { attachment_paths: attachmentPaths } : {}),
        ...(permissionMode === "ask" ? { permission_mode: "ask" }         : {}),
      };

      const token = typeof window !== "undefined" ? localStorage.getItem("kodo_token") : null;

      const res = await fetch(`${BASE_URL}/run`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body:   JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await readJson<{ error?: string; details?: string }>(res);
        throw new Error(data.details || data.error || `Request failed (${res.status})`);
      }

      await parseSSE(res, onEvent, onDone, onError, sessionId);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err instanceof Error ? err.message : "Unknown error");
    }
  })();

  return () => controller.abort();
}

// ─── Background jobs (survive refresh / session switch) ───────────────────────

export interface ActiveJob {
  requestId: string;
  sessionId: string;
  status:    string;
  title?:    string;
  createdAt?: number;
}

/** Jobs still running for the current user (optionally scoped to one session). */
export async function fetchActiveJobs(sessionId?: string | null): Promise<ActiveJob[]> {
  const token = getToken();
  if (!token) return [];
  const url = sessionId
    ? `${BASE_URL}/jobs?session_id=${encodeURIComponent(sessionId)}`
    : `${BASE_URL}/jobs`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return [];
  const data = await readJson<{ ok: boolean; jobs?: ActiveJob[] }>(res);
  return Array.isArray(data.jobs) ? data.jobs : [];
}

/**
 * Re-attach to a still-running job's live event stream (after a page refresh or
 * session switch). Replays buffered events then streams live ones — same event
 * shape as sendMessage. Returns a detach function; detaching does NOT stop the
 * job (use cancelJob for that).
 */
export function reconnectJob(
  requestId: string,
  onEvent:   (event: SSEEvent) => void,
  onDone:    (sessionId: string, requestId?: string | null) => void,
  onError:   (err: string) => void,
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(`${BASE_URL}/run/${encodeURIComponent(requestId)}/stream`, {
        method:  "GET",
        headers: authHeaders(),
        signal:  controller.signal,
      });
      if (res.status === 404) { onDone("", requestId); return; } // job already finished + GC'd
      if (!res.ok) {
        const data = await readJson<{ error?: string }>(res);
        throw new Error(data.error || `Reconnect failed (${res.status})`);
      }
      await parseSSE(res, onEvent, onDone, onError, null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err instanceof Error ? err.message : "Reconnect error");
    }
  })();

  return () => controller.abort();
}

/** Explicitly stop a running job (the actual "Stop" action). */
export async function cancelJob(requestId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/cancel/${encodeURIComponent(requestId)}`, {
    method: "POST", headers: authHeaders(),
  });
  // Best-effort: a 404 just means it already finished.
  if (!res.ok && res.status !== 404) {
    const data = await readJson<{ error?: string }>(res);
    throw new Error(data.error || "Failed to cancel");
  }
}

// ─── Sessions ─────────────────────────────────────────────────

export async function fetchSessions(): Promise<Session[]> {
  const token = getToken();
  if (!token) return [];
  const res  = await fetch(`${BASE_URL}/sessions`, { method: "GET", cache: "no-store", headers: authHeaders() });
  if (res.status === 401) return [];
  const data = await readJson<{ ok: boolean; sessions?: Session[]; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to fetch sessions");
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function fetchSessionMessages(sessionId: string): Promise<Message[]> {
  const res  = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", cache: "no-store", headers: authHeaders() });
  const data = await readJson<{ ok: boolean; messages?: Message[]; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to fetch messages");
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function deleteSession(sessionId: string): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res  = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to delete session");
}

export async function callUndo(sessionId: string, requestId: string): Promise<UndoResult> {
  const res  = await fetch(`${BASE_URL}/undo`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ session_id: sessionId, request_id: requestId }) });
  const data = await readJson<UndoResult & { error?: string; details?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.details || data.error || `Undo failed (${res.status})`);
  return data;
}

// ─── Upload ───────────────────────────────────────────────────

async function uploadAttachment(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  const res  = await fetch(UPLOAD_URL, { method: "POST", body: formData });
  const data = await readJson<{ ok: boolean; path?: string; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  if (!data.path) throw new Error("Upload succeeded but no path returned.");
  return data.path;
}

export async function uploadFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) paths.push(await uploadAttachment(f));
  return paths;
}

export async function uploadFile(file: File): Promise<string> {
  return uploadAttachment(file);
}

export async function transcribeAudio(audioBlob: Blob, filename = "voice.webm"): Promise<string> {
  const formData = new FormData();
  formData.append("audio", audioBlob, filename);
  const res  = await fetch(TRANSCRIBE_URL, { method: "POST", body: formData });
  const data = await readJson<{ ok: boolean; transcribed_text?: string; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || `Transcription failed (${res.status})`);
  return (data.transcribed_text || "").trim();
}

// ─── Settings ─────────────────────────────────────────────────

export interface Capabilities {
  chatEnabled:   boolean;
  uploadEnabled: boolean;
  textModel:     { provider: string; model: string } | null;
  visionModel:   { provider: string; model: string } | null;
}

export interface SettingsPayload {
  textModel:       string;
  textApiKey:      string;
  textBaseUrl?:    string;
  visionModel?:    string | null;
  visionApiKey?:   string | null;
  visionBaseUrl?:  string | null;
  useVisionSameKey?: boolean;
}

export interface GapGPTModel { id: string; name: string; vision: boolean; thinking: boolean; }

export async function fetchGapGPTModels(): Promise<GapGPTModel[]> {
  const res  = await fetch(`${SETTINGS_URL}/gapgpt-models`, { cache: "no-store" });
  const data = await readJson<{ ok: boolean; models: GapGPTModel[] }>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch GapGPT models");
  return data.models;
}

export async function fetchCapabilities(): Promise<Capabilities> {
  // Settings are per-user now, so this route requires auth.
  const res  = await fetch(`${SETTINGS_URL}/capabilities`, { cache: "no-store", headers: authHeaders() });
  const data = await readJson<{ ok: boolean } & Capabilities>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch capabilities");
  return { chatEnabled: data.chatEnabled, uploadEnabled: data.uploadEnabled, textModel: data.textModel, visionModel: data.visionModel };
}

export async function fetchCurrentSettings(): Promise<{ configured: boolean; settings: any; capabilities: Capabilities }> {
  const res  = await fetch(`${SETTINGS_URL}`, { cache: "no-store", headers: authHeaders() });
  const data = await readJson<any>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch settings");
  return { configured: data.configured, settings: data.settings, capabilities: data.capabilities };
}

export async function saveSettings(payload: SettingsPayload): Promise<Capabilities> {
  const res  = await fetch(`${SETTINGS_URL}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await readJson<{ ok: boolean; capabilities: Capabilities; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save");
  return data.capabilities;
}

export async function testConnection(model: string, apiKey: string, baseUrl?: string): Promise<string> {
  const res  = await fetch(`${SETTINGS_URL}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, apiKey, baseUrl }) });
  const data = await readJson<{ ok: boolean; message?: string; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Test failed");
  return data.message || "Connected";
}

// ─── Auth ─────────────────────────────────────────────────────

export interface User { id: number; email: string; name: string; plan: string; created_at: string; }

async function notifyExtension(token: string, sessionId: string): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/handshake`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, sessionId }),
    });
  } catch {}
}

export async function apiSignup(email: string, password: string, name: string) {
  const res  = await fetch(`${AUTH_URL}/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name }) });
  const data = await readJson<{ ok: boolean; token?: string; sessionId?: string; user?: User; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Signup failed");
  localStorage.setItem("kodo_token", data.token!);
  localStorage.setItem("kodo_session_id", data.sessionId!);
  await notifyExtension(data.token!, data.sessionId!);
  return data;
}

export async function apiLogin(email: string, password: string) {
  const res  = await fetch(`${AUTH_URL}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const data = await readJson<{ ok: boolean; token?: string; sessionId?: string; user?: User; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");
  localStorage.setItem("kodo_token", data.token!);
  localStorage.setItem("kodo_session_id", data.sessionId!);
  await notifyExtension(data.token!, data.sessionId!);
  return data;
}

export async function apiLogout(): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/logout`, { method: "POST", headers: authHeaders() });
    await fetch(`${AUTH_URL}/handshake`, { method: "DELETE" });
  } catch {}
  localStorage.removeItem("kodo_token");
  localStorage.removeItem("kodo_session_id");
}

export async function apiMe(): Promise<User | null> {
  const token = getToken();
  if (!token) return null;
  const res  = await fetch(`${AUTH_URL}/me`, { headers: authHeaders(), cache: "no-store" });
  const data = await readJson<{ ok: boolean; user?: User }>(res);
  return data.ok && data.user ? data.user : null;
}

export function isLoggedIn(): boolean { return !!getToken(); }

// ─── Workspace ────────────────────────────────────────────────

export async function fetchGitStatus(): Promise<GitStatus> {
  const res  = await fetch(`${WORKSPACE_URL}/git`, { headers: authHeaders(), cache: "no-store" });
  const data = await readJson<{ ok: boolean } & GitStatus>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch git status");
  return {
    branch: data.branch, dirty: data.dirty, uncommittedCount: data.uncommittedCount ?? 0,
    ahead: data.ahead, hasUpstream: data.hasUpstream, pullRequestUrl: data.pullRequestUrl ?? null,
  };
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export async function fetchGitBranches(): Promise<GitBranchInfo[]> {
  const res  = await fetch(`${WORKSPACE_URL}/git/branches`, { headers: authHeaders(), cache: "no-store" });
  const data = await readJson<{ ok: boolean; branches: GitBranchInfo[] }>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch git branches");
  return Array.isArray(data.branches) ? data.branches : [];
}

export async function switchGitBranch(branch: string): Promise<{ ok: boolean; error?: string }> {
  const res  = await fetch(`${WORKSPACE_URL}/git/checkout`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ branch }),
  });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to switch branch");
  return data;
}

export async function gitCommit(message: string): Promise<{ hash: string; message: string }> {
  const res  = await fetch(`${WORKSPACE_URL}/git/commit`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = await readJson<{ ok: boolean; hash?: string; message?: string; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Commit failed");
  return { hash: data.hash || "", message: data.message || message };
}

export async function gitPush(): Promise<{ branch: string; output: string; pullRequestUrl: string | null }> {
  const res  = await fetch(`${WORKSPACE_URL}/git/push`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = await readJson<{ ok: boolean; branch?: string; output?: string; pullRequestUrl?: string | null; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Push failed");
  return { branch: data.branch || "", output: data.output || "", pullRequestUrl: data.pullRequestUrl ?? null };
}

export async function fetchWorkspaceFiles(): Promise<WorkspaceFileEntry[]> {
  const res  = await fetch(`${WORKSPACE_URL}/files`, { headers: authHeaders(), cache: "no-store" });
  const data = await readJson<{ ok: boolean; files: WorkspaceFileEntry[] }>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch workspace files");
  return Array.isArray(data.files) ? data.files : [];
}

// ─── Root picker ──────────────────────────────────────────────
// Flat list of SIBLING project folders (e.g. ~/Developer/ai-sandbox and
// ~/Developer/avand) to switch between — same shape as the branch picker:
// no hierarchy, no browsing step, click a name and it switches.

export interface WorkspaceRootInfo {
  path:     string;
  name:     string;
  current?: boolean;
}

export interface WorkspaceRootsResult {
  current: WorkspaceRootInfo;
  options: WorkspaceRootInfo[];
}

export async function fetchWorkspaceRoots(): Promise<WorkspaceRootsResult> {
  const res  = await fetch(`${WORKSPACE_URL}/roots`, { headers: authHeaders(), cache: "no-store" });
  const data = await readJson<{ ok: boolean } & WorkspaceRootsResult>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch workspace roots");
  return {
    current: data.current,
    options: Array.isArray(data.options) ? data.options : [],
  };
}

export async function switchWorkspaceRoot(root: WorkspaceRootInfo): Promise<void> {
  const res  = await fetch(`${AUTH_URL}/workspace`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ workspacePath: root.path, workspaceName: root.name }),
  });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to switch workspace root");
}

// ─── Plan approval ────────────────────────────────────────────

export async function confirmPlan(requestId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/confirm/${encodeURIComponent(requestId)}`, {
    method: "POST", headers: authHeaders(),
  });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to confirm plan");
}

export async function rejectPlan(requestId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/reject/${encodeURIComponent(requestId)}`, {
    method: "POST", headers: authHeaders(),
  });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to reject plan");
}

// ─── Clarifying questions (ask_user tool) ──────────────────────

export async function answerQuestion(requestId: string, answer: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/answer/${encodeURIComponent(requestId)}`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  const data = await readJson<{ ok: boolean; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to send answer");
}

// ─── Compact ──────────────────────────────────────────────────

export async function compactConversation(sessionId: string): Promise<{ summary: string; messageCount: number }> {
  const res  = await fetch(`${BASE_URL}/compact`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await readJson<{ ok: boolean; summary: string; messageCount: number; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to compact");
  return { summary: data.summary, messageCount: data.messageCount };
}
