const BASE_URL = "http://localhost:9000/api/agent";
const UPLOAD_URL = `${BASE_URL}/upload`;
const TRANSCRIBE_URL = `${BASE_URL}/transcribe`;
const SETTINGS_URL = "http://localhost:9000/api/settings";
const AUTH_URL = "http://localhost:9000/api/auth";

export interface Session {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  intent: string | null;
  created_at: string;
}

type SessionsResponse = {
  ok: boolean;
  error?: string;
  sessions?: Session[];
};

type MessagesResponse = {
  ok: boolean;
  error?: string;
  messages?: Message[];
};

type DeleteResponse = {
  ok: boolean;
  error?: string;
};


type TranscribeResponse = {
  ok: boolean;
  error?: string;
  transcribed_text?: string;
  session_id?: string;
  attachment_paths?: string[];
  message?: string;
};

type RunPayload = {
  message: string;
  session_id?: string;
  attachment_paths?: string[];
};

// 🔹 نوع رویدادهایی که از SSE می‌گیریم
export type SSEEvent =
  | { type: "start"; sessionId: string; requestId?: string; intent?: string | null }
  | { type: "content"; chunk: string }
  | { type: "done"; sessionId: string; requestId?: string | null }
  | { type: "progress"; stage?: string; message?: string }
  | { type: "plan_metadata"; raw: any };

export type UndoStats = {
  total: number;
  restored: number;
  deleted: number;
  no_op: number;
  failed: number;
};

export type UndoFileResult = {
  file: string;
  action: string;
  reason?: string;
  error?: string;
};

export type UndoResult = {
  ok: boolean;
  session_id: string;
  request_id: string;
  result: {
    stats: UndoStats;
    files: UndoFileResult[];
  };
};

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text || res.statusText || "Invalid server response");
  }
}

export async function transcribeAudio(
  audioBlob: Blob,
  filename = "voice.webm"
): Promise<string> {
  const formData = new FormData();
  formData.append("audio", audioBlob, filename);

  const res = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    body: formData,
  });

  const data = await readJson<TranscribeResponse>(res);

  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Transcription failed with status ${res.status}`);
  }

  return (data.transcribed_text || "").trim();
}

// 🔹 parseSSE: event-based + نگه‌داشتن sessionId/requestId
async function parseSSE(
  res: Response,
  onEvent: (event: SSEEvent) => void,
  onDone: (sessionId: string, requestId?: string | null) => void,
  onError: (err: string) => void,
  fallbackSessionId: string | null
) {
  if (!res.body) {
    onError("No response body received");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let returnedSessionId = fallbackSessionId ?? "";
  let returnedRequestId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const raw = trimmed.slice(5).trim();
          if (!raw) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            const msg = "Malformed server event (invalid JSON)";
            onError(msg);
            continue;
          }

          if (parsed?.session_id) {
            returnedSessionId = String(parsed.session_id);
          }
          if (parsed?.request_id) {
            returnedRequestId = String(parsed.request_id);
          }

          const type = parsed?.type;

          if (type === "start") {
            if (parsed.session_id) {
              returnedSessionId = String(parsed.session_id);
            }
            if (parsed.request_id) {
              returnedRequestId = String(parsed.request_id);
            }

            onEvent({
              type: "start",
              sessionId: returnedSessionId,
              requestId: returnedRequestId ?? undefined,
              intent: parsed.metadata?.intent ?? null,
            });
          } else if (type === "content") {
            const content = parsed.content;
            if (typeof content === "string" && content) {
              onEvent({ type: "content", chunk: content });
            }
          } else if (type === "progress") {
            onEvent({
              type: "progress",
              stage: parsed.stage,
              message: parsed.message,
            });
          } else if (type === "plan_metadata") {
            onEvent({ type: "plan_metadata", raw: parsed });
          } else if (type === "done") {
            if (parsed.metadata?.request_id && !returnedRequestId) {
              returnedRequestId = String(parsed.metadata.request_id);
            }

            const finalSessionId = returnedSessionId || fallbackSessionId || "";

            const event: SSEEvent = {
              type: "done",
              sessionId: finalSessionId,
              requestId: returnedRequestId,
            };

            onEvent(event);
            onDone(finalSessionId, returnedRequestId);
          } else if (type === "error") {
            const msg = parsed.details || parsed.error || "Unknown error from server";
            onError(msg);
            throw new Error(msg);
          }
        }
      }
    }

    if (returnedSessionId) {
      onDone(returnedSessionId, returnedRequestId);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Malformed server event / SSE error";
    onError(message);
  }
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: "GET",
    cache: "no-store",
  });

  const data = await readJson<SessionsResponse>(res);

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to fetch sessions");
  }

  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function fetchSessionMessages(sessionId: string): Promise<Message[]> {
  const res = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    cache: "no-store",
  });

  const data = await readJson<MessagesResponse>(res);

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to fetch session messages");
  }

  return Array.isArray(data.messages) ? data.messages : [];
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });

  const data = await readJson<DeleteResponse>(res);

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to delete session");
  }
}

// 🔹 API فراخوانی Undo
export async function callUndo(
  sessionId: string,
  requestId: string
): Promise<UndoResult> {
  console.log("[UNDO] request payload", { sessionId, requestId });

  const res = await fetch(`${BASE_URL}/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request_id: requestId }),
  });

  const text = await res.text();
  console.log("[UNDO] raw response", text);

  let data: UndoResult & { error?: string; details?: string; message?: string };
  try {
    data = text ? JSON.parse(text) : ({ ok: false } as any);
  } catch {
    throw new Error(
      text || `Undo failed with non-JSON response (status ${res.status})`
    );
  }

  if (!res.ok || !data.ok) {
    throw new Error(
      data.details ||
        data.error ||
        (data as any).message ||
        `Failed to undo changes (status ${res.status})`
    );
  }

  return data;
}

// 🔹 sendMessage: کار با SSEEvent
// Replace the entire sendMessage function in app/lib/api.ts

export function sendMessage(
  message: string,
  file: File | File[] | null,
  sessionId: string | null,
  onEvent: (event: SSEEvent) => void,
  onDone: (sessionId: string, requestId?: string | null) => void,
  onError: (err: string) => void
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      let attachmentPaths: string[] = [];

      const filesToUpload = Array.isArray(file)
        ? file.filter(Boolean)
        : file
          ? [file]
          : [];

      if (filesToUpload.length > 0) {
        attachmentPaths = [];

        for (const currentFile of filesToUpload) {
          const uploadedPath = await uploadAttachment(currentFile);
          if (uploadedPath) {
            attachmentPaths.push(uploadedPath);
          }
        }
      }

      const payload: RunPayload = {
        message,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(attachmentPaths.length ? { attachment_paths: attachmentPaths } : {}),
      };

      // [KODO] Include auth token so the backend can look up the workspace path
      // bound by the VS Code extension for this user's session.
      const token =
        typeof window !== "undefined" ? localStorage.getItem("kodo_token") : null;

      const res = await fetch(`${BASE_URL}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await readJson<{ error?: string; details?: string }>(res);
        throw new Error(
          data.details || data.error || `Request failed with status ${res.status}`
        );
      }

      await parseSSE(res, onEvent, onDone, onError, sessionId);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err instanceof Error ? err.message : "Unknown error");
    }
  })();

  return () => controller.abort();
}

type UploadResponse = {
  ok: boolean;
  error?: string;
  path?: string;
  filename?: string;
  url?: string;
};

async function uploadAttachment(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    body: formData,
  });

  const data = await readJson<UploadResponse>(res);

  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Upload failed with status ${res.status}`);
  }

  if (!data.path) {
    throw new Error("Upload succeeded, but no file path was returned.");
  }

  return data.path;
}

export async function uploadFiles(files: File[]): Promise<string[]> {
  if (!Array.isArray(files) || files.length === 0) return [];

  const uploadedPaths: string[] = [];

  for (const file of files) {
    const path = await uploadAttachment(file);
    uploadedPaths.push(path);
  }

  return uploadedPaths;
}

export async function uploadFile(file: File): Promise<string> {
  return uploadAttachment(file);
}

// ============================================================
// Settings API
// ============================================================


export interface Provider {
  id: string;
  name: string;
  models: { id: string; name: string; vision: boolean }[];
}

export interface Capabilities {
  chatEnabled: boolean;
  uploadEnabled: boolean;
  textModel: { provider: string; model: string } | null;
  visionModel: { provider: string; model: string } | null;
}

export interface SettingsPayload {
  textProvider: string;
  textModel: string;
  textApiKey: string;
  visionProvider?: string | null;
  visionModel?: string | null;
  visionApiKey?: string | null;
  useVisionSameKey?: boolean;
}

// در app/lib/api.ts اضافه کن

export interface GapGPTModel {
  id: string;
  name: string;
  vision: boolean;
  thinking: boolean;
}

export async function fetchGapGPTModels(): Promise<GapGPTModel[]> {
  const res = await fetch(`${SETTINGS_URL}/gapgpt-models`, {
    cache: "no-store",
  });
  const data = await readJson<{ ok: boolean; models: GapGPTModel[] }>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch GapGPT models");
  return data.models;
}


export interface SettingsPayload {
  textModel: string;
  textApiKey: string;
  textBaseUrl?: string;
  visionModel?: string | null;
  visionApiKey?: string | null;
  visionBaseUrl?: string | null;
  useVisionSameKey?: boolean;
}

export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await fetch(`${SETTINGS_URL}/capabilities`, { cache: "no-store" });
  const data = await readJson<{ ok: boolean } & Capabilities>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch capabilities");
  return { chatEnabled: data.chatEnabled, uploadEnabled: data.uploadEnabled, textModel: data.textModel, visionModel: data.visionModel };
}

export async function fetchCurrentSettings(): Promise<{ configured: boolean; settings: any; capabilities: Capabilities }> {
  const res = await fetch(`${SETTINGS_URL}`, { cache: "no-store" });
  const data = await readJson<any>(res);
  if (!res.ok || !data.ok) throw new Error("Failed to fetch settings");
  return { configured: data.configured, settings: data.settings, capabilities: data.capabilities };
}

export async function saveSettings(payload: SettingsPayload): Promise<Capabilities> {
  const res = await fetch(`${SETTINGS_URL}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await readJson<{ ok: boolean; capabilities: Capabilities; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save");
  return data.capabilities;
}

export async function testConnection(model: string, apiKey: string, baseUrl?: string): Promise<string> {
  const res = await fetch(`${SETTINGS_URL}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, apiKey, baseUrl }) });
  const data = await readJson<{ ok: boolean; message?: string; error?: string }>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Test failed");
  return data.message || "Connected";
}

// ============================================================
// Auth API
// ============================================================
// Paste this block at the bottom of app/lib/api.ts


export interface User {
  id: number;
  email: string;
  name: string;
  plan: string;
  created_at: string;
}

type AuthResponse = {
  ok: boolean;
  error?: string;
  token?: string;
  sessionId?: string;
  user?: User;
};

type MeResponse = {
  ok: boolean;
  error?: string;
  user?: User;
  session?: {
    id: string;
    workspace_path: string | null;
    workspace_name: string | null;
  };
};

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

// Notifies the VS Code extension that login succeeded
// by writing the token to ~/.kodo/token.json via the handshake endpoint
async function notifyExtension(token: string, sessionId: string): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, sessionId }),
    });
  } catch {
    // Non-critical — extension stays in "waiting" state if this fails
  }
}

export async function apiSignup(
  email: string,
  password: string,
  name: string
): Promise<AuthResponse> {
  const res = await fetch(`${AUTH_URL}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  const data = await readJson<AuthResponse>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Signup failed");

  localStorage.setItem("kodo_token", data.token!);
  localStorage.setItem("kodo_session_id", data.sessionId!);

  await notifyExtension(data.token!, data.sessionId!);

  return data;
}

export async function apiLogin(
  email: string,
  password: string
): Promise<AuthResponse> {
  const res = await fetch(`${AUTH_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const data = await readJson<AuthResponse>(res);
  if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");

  localStorage.setItem("kodo_token", data.token!);
  localStorage.setItem("kodo_session_id", data.sessionId!);

  await notifyExtension(data.token!, data.sessionId!);

  return data;
}

export async function apiLogout(): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/logout`, {
      method: "POST",
      headers: authHeaders(),
    });
    // Clear the handshake file so the extension detects logout
    await fetch(`${AUTH_URL}/handshake`, { method: "DELETE" });
  } catch {
    // Best-effort — always clear local state
  }

  localStorage.removeItem("kodo_token");
  localStorage.removeItem("kodo_session_id");
}

export async function apiMe(): Promise<User | null> {
  const token = getToken();
  if (!token) return null;

  const res = await fetch(`${AUTH_URL}/me`, {
    headers: authHeaders(),
    cache: "no-store",
  });

  const data = await readJson<MeResponse>(res);
  return data.ok && data.user ? data.user : null;
}

export function isLoggedIn(): boolean {
  return !!getToken();
}