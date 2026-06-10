// ./lib/api.ts

const BASE_URL = "http://localhost:9000/api/agent";
const UPLOAD_URL = `${BASE_URL}/upload`;

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

type UploadResponse = {
  ok: boolean;
  error?: string;
  path?: string;
  filename?: string;
  url?: string;
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

  // برای دیباگ: متن خام پاسخ را لاگ کن
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
export function sendMessage(
  message: string,
  file: File | null,
  sessionId: string | null,
  onEvent: (event: SSEEvent) => void,
  onDone: (sessionId: string, requestId?: string | null) => void,
  onError: (err: string) => void
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      let attachmentPaths: string[] = [];

      if (file) {
        const uploadedPath = await uploadAttachment(file);
        attachmentPaths = [uploadedPath];
      }

      const payload: RunPayload = {
        message,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(attachmentPaths.length ? { attachment_paths: attachmentPaths } : {}),
      };

      const res = await fetch(`${BASE_URL}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
