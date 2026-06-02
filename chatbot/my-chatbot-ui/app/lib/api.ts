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

async function parseSSE(
  res: Response,
  onChunk: (chunk: string) => void,
  onDone: (sessionId: string) => void,
  onError: (err: string) => void,
  fallbackSessionId: string | null
) {
  if (!res.body) {
    throw new Error("No response body received");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let returnedSessionId = fallbackSessionId ?? "";

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

        try {
          const parsed = JSON.parse(raw);

          if (parsed?.session_id) {
            returnedSessionId = String(parsed.session_id);
          }

          if (parsed?.type === "start") {
            if (parsed.session_id) {
              returnedSessionId = String(parsed.session_id);
            }
          } else if (parsed?.type === "content") {
            if (typeof parsed.content === "string" && parsed.content) {
              onChunk(parsed.content);
            }
          } else if (parsed?.type === "done") {
            onDone(returnedSessionId || fallbackSessionId || "");
          } else if (parsed?.type === "error") {
            throw new Error(parsed.details || parsed.error || "Unknown error");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Malformed server event";
          onError(message);
          throw err;
        }
      }
    }
  }

  if (returnedSessionId) {
    onDone(returnedSessionId);
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

export function sendMessage(
  message: string,
  file: File | null,
  sessionId: string | null,
  onChunk: (chunk: string) => void,
  onDone: (sessionId: string) => void,
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
        throw new Error(data.details || data.error || `Request failed with status ${res.status}`);
      }

      await parseSSE(res, onChunk, onDone, onError, sessionId);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err instanceof Error ? err.message : "Unknown error");
    }
  })();

  return () => controller.abort();
}