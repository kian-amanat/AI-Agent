const BASE_URL = "https://demo.avand.ai/back/ai/v1";
const BASE_URL_FOLDERS = process.env.NEXT_PUBLIC_BASE_URL_FOLDERS ?? "https://demo.avand.ai/back/api/folders";
const BASE_URL_DOCS = process.env.NEXT_PUBLIC_BASE_URL_DOCS ?? "https://demo.avand.ai/back/api/documents";

console.log("API1", BASE_URL);
console.log("API2", BASE_URL_FOLDERS);
console.log("API3", BASE_URL_DOCS);

const DEFAULT_USER_ID =
  typeof window !== "undefined" ? localStorage.getItem("user_id") || "" : "";

// -------------------- Configurable timeouts --------------------
const DEFAULT_TIMEOUT_MS = 45_000; // 45s for normal requests
const STREAM_OVERALL_TIMEOUT_MS = 120_000; // 2min overall for streaming endpoints
const STREAM_INACTIVITY_TIMEOUT_MS = 15_000; // 15s inactivity during streaming

// -------------------- Simple log throttle --------------------
// Prevent huge EPIPE/console storm by limiting logs to a few per second.
const _logState: { lastTimestamp: number; count: number } = { lastTimestamp: 0, count: 0 };
function throttledLogError(...args: any[]) {
  const now = Date.now();
  if (now - _logState.lastTimestamp > 1000) {
    _logState.lastTimestamp = now;
    _logState.count = 0;
  }
  _logState.count++;
  // allow up to 6 error logs per second
  if (_logState.count <= 6) {
    // prefer console.warn to avoid too noisy stack traces in some hosts
    // but still provide important debugging info
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

// -------------------- helpers --------------------
function userHeaders(userId: string | number) {
  const sid = String(userId ?? DEFAULT_USER_ID ?? "");
  return {
    "Content-Type": "application/json",
    "X-User-Id": sid,
    "user-id": sid,
    "user_id": sid,
  };
}

/**
 * fetchWithTimeout
 * - wraps fetch with an AbortController that will abort after timeoutMs
 * - if caller provides signal in opts, it will be wired to our controller
 */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // wire external signal to our controller if provided
  if (init.signal) {
    const external = init.signal;
    if (!external.aborted) {
      const onAbort = () => controller.abort();
      external.addEventListener("abort", onAbort, { once: true });
    } else {
      controller.abort();
    }
  }

  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err: any) {
    clearTimeout(timeout);
    // normalize abort reason
    if (err && err.name === "AbortError") {
      throw new Error("timeout_or_abort");
    }
    throw err;
  }
}

/**
 * readStreamNDJSON
 * - reads a ReadableStream via reader.getReader()
 * - supports overallTimeoutMs and inactivityTimeoutMs which both abort via controller
 * - returns assembled answer string or throws an error
 */
async function readStreamNDJSON(
  res: Response,
  controller: AbortController,
  overallTimeoutMs = STREAM_OVERALL_TIMEOUT_MS,
  inactivityTimeoutMs = STREAM_INACTIVITY_TIMEOUT_MS
) {
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new Error("no_stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = "";

  let overallTimer: any = null;
  let inactivityTimer: any = null;
  let done = false;

  function clearTimers() {
    if (overallTimer) {
      clearTimeout(overallTimer);
      overallTimer = null;
    }
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  }

  // abort helpers
  function abortAll(reason = "stream_timeout") {
    try {
      controller.abort();
    } catch (e) {}
    clearTimers();
  }

  // overall timeout
  overallTimer = setTimeout(() => {
    abortAll("overall_timeout");
  }, overallTimeoutMs);

  // reset inactivity timer
  function resetInactivity() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      abortAll("inactivity_timeout");
    }, inactivityTimeoutMs);
  }
  resetInactivity();

  try {
    while (true) {
      const { value, done: rDone } = await reader.read();
      if (rDone) {
        done = true;
        break;
      }

      // got chunk -> reset inactivity timer
      resetInactivity();

      if (value) {
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            // support a few shapes
            if (obj?.type === "delta" && typeof obj.delta === "string") {
              assembled += obj.delta;
            } else if (obj?.type === "done") {
              const answer = obj.answer ?? assembled;
              clearTimers();
              return { ok: true, answer, user_message_id: obj.user_message_id ?? null };
            } else if (obj?.answer && typeof obj.answer === "string") {
              clearTimers();
              return { ok: true, answer: obj.answer, user_message_id: obj.user_message_id ?? null };
            } else if (typeof obj === "string") {
              assembled += obj;
            } else if (obj?.delta && typeof obj.delta === "string") {
              assembled += obj.delta;
            } else {
              // ignore unknown chunks
            }
          } catch (err) {
            // ignore parse failures for individual lines
            // but don't spam console
            // throttledLogError("stream parse line failed", trimmed, err);
          }
        }
      }
    }

    // stream ended: process leftover buffer
    if (buffer.trim()) {
      const lines = buffer.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        try {
          const obj = JSON.parse(l);
          if (obj?.type === "delta" && obj.delta) assembled += obj.delta;
          else if (obj?.type === "done") {
            const answer = obj.answer ?? assembled;
            clearTimers();
            return { ok: true, answer, user_message_id: obj.user_message_id ?? null };
          } else if (obj?.answer) {
            clearTimers();
            return { ok: true, answer: obj.answer, user_message_id: obj.user_message_id ?? null };
          }
        } catch {
          // ignore leftover parse failures
        }
      }
    }

    clearTimers();
    if (assembled) return { ok: true, answer: assembled, user_message_id: null };
    return { ok: false, error: "invalid_stream", raw: buffer || null };
  } catch (err: any) {
    clearTimers();
    // reader/stream aborted
    if (err && err.message === "timeout_or_abort") {
      return { ok: false, error: "timeout_or_abort" };
    }
    // if controller.signal.aborted -> map to timeout_or_abort
    if (controller.signal && controller.signal.aborted) {
      return { ok: false, error: "timeout_or_abort" };
    }
    // fallback
    throttledLogError("readStreamNDJSON failed:", err);
    return { ok: false, error: "stream_error", detail: String(err) };
  } finally {
    try {
      // try to cancel reader gently
      reader.cancel().catch(() => {});
    } catch {}
  }
}

// ---------------------- CREATE SESSION ----------------------
export async function createSession(message: string, userId: string | number) {
  if (userId === undefined || userId === null || String(userId).trim() === "") {
    throw new Error("Missing USER_ID");
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/sessions`,
      {
        method: "POST",
        headers: userHeaders(userId),
        body: JSON.stringify({ message }),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      // throttledLogError("createSession failed:", res.status, await res.text());
      return null;
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("createSession timeout/abort");
      return null;
    }
    throttledLogError("createSession error:", err);
    return null;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}

// ---------------------- SEND CHAT ----------------------
export async function sendChat(
  message: string,
  sessionId: string,
  userId?: string | number,
  opts?: { stream?: boolean } // NEW: optional streaming flag
) {
  const uid = userId ?? DEFAULT_USER_ID;
  const streamMode = !!(opts && opts.stream);

  if (!uid) throw new Error("Missing USER_ID");
  if (!sessionId) throw new Error("Missing sessionId");

  const controller = new AbortController();
  try {
    // ensure Accept header prefers streaming formats when requested
    const baseHeaders = userHeaders(uid) || {};
    const headers = {
      ...baseHeaders,
      Accept: streamMode
        ? "text/event-stream, application/ndjson, application/json;q=0.9"
        : (baseHeaders["Accept"] || baseHeaders["accept"] || "application/json"),
    };

    // include explicit stream flag in body so server can enable streaming if supported
    const body = JSON.stringify({ session_id: sessionId, message, stream: streamMode });

    const res = await fetchWithTimeout(
      `${BASE_URL}/chat`,
      {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS // short wait for initial response headers
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // throttledLogError("sendChat failed:", res.status, txt);
      return { ok: false, status: res.status, error: txt, raw: txt };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    // If JSON response and NOT streaming mode -> parse JSON and return
    if (contentType.includes("application/json") && !streamMode) {
      try {
        const json = await res.json();
        if (json && typeof json === "object") return json;
        return { ok: false, error: "invalid_json_shape", raw: String(json) };
      } catch (err) {
        // fallthrough to streaming/text handling
        // throttledLogError("sendChat: JSON parse failed, falling back to stream/text:", err);
      }
    }

    // If streamable body -> either return reader (streamMode) or process with readStreamNDJSON
    if (res.body && typeof res.body.getReader === "function") {
      if (streamMode) {
        // Return the raw reader to the caller so they can process chunks
        const reader = res.body.getReader();
        return {
          ok: true,
          isStream: true,
          reader,
          // a simple cancel helper to abort the underlying fetch
          cancel: () => {
            try {
              controller.abort();
            } catch {}
          },
          contentType,
        };
      } else {
        // we will honor overall + inactivity timeouts when reading
        const streamController = new AbortController();
        // wire stream abort to outer controller as well
        streamController.signal.addEventListener("abort", () => {
          try {
            controller.abort();
          } catch {}
        });

        // read stream (this handles its own abort/timeouts and returns structured result)
        const streamResult = await readStreamNDJSON(
          res,
          streamController,
          STREAM_OVERALL_TIMEOUT_MS,
          STREAM_INACTIVITY_TIMEOUT_MS
        );
        return streamResult;
      }
    }

    // Fallback: try reading full text
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // parse NDJSON / lines
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      let assembled = "";
      for (const l of lines) {
        try {
          const obj = JSON.parse(l);
          if (obj?.type === "delta" && obj.delta) {
            assembled += obj.delta;
          } else if (obj?.type === "done") {
            return { ok: true, answer: obj.answer ?? assembled, user_message_id: obj.user_message_id ?? null, raw: text };
          } else if (obj?.answer) {
            return { ok: true, answer: obj.answer, user_message_id: obj.user_message_id ?? null, raw: text };
          }
        } catch {
          // ignore
        }
      }
      if (assembled) return { ok: true, answer: assembled, raw: text };
      return { ok: false, error: "invalid_json", raw: text };
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("sendChat timeout/abort:", sessionId);
      return { ok: false, error: "timeout_or_abort" };
    }
    throttledLogError("sendChat error:", err);
    return { ok: false, error: "network_error", detail: String(err) };
  } finally {
    // IMPORTANT:
    // If caller requested streaming we must NOT abort here because caller may still be reading.
    // Only abort automatically in non-streaming use-cases.
    if (!streamMode) {
      try {
        controller.abort();
      } catch {}
    }
  }
}

// ---------------------- GET ALL SESSIONS ----------------------
export async function getSessions(userId: string | number) {
  if (userId === undefined || userId === null || String(userId).trim() === "") {
    return [];
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/sessions`, { method: "GET", headers: userHeaders(userId), signal: controller.signal }, DEFAULT_TIMEOUT_MS);

    if (!res.ok) {
      // throttledLogError("getSessions failed:", res.status);
      return [];
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("getSessions timeout/abort");
      return [];
    }
    throttledLogError("getSessions error:", err);
    return [];
  } finally {
    try { controller.abort(); } catch {}
  }
}

// ---------------------- GET SESSION MESSAGES ----------------------
export async function getSessionMessages(userId: string | number, sessionId: string) {
  if (userId === undefined || userId === null || String(userId).trim() === "") {
    return [];
  }
  if (!sessionId) {
    return [];
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/sessions/${encodeURIComponent(String(sessionId))}/messages`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "user-id": String(userId),
          "X-User-Id": String(userId),
        },
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      // throttledLogError("getSessionMessages failed:", res.status);
      return [];
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("getSessionMessages timeout/abort:", sessionId);
      return [];
    }
    throttledLogError("getSessionMessages error:", err);
    return [];
  } finally {
    try { controller.abort(); } catch {}
  }
}

// ---------------------- DELETE SESSION ----------------------
export async function deleteSession(sessionId: string, userId: string | number) {
  if (!sessionId) {
    return null;
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/sessions/${sessionId}`, { method: "DELETE", headers: userHeaders(userId), signal: controller.signal }, DEFAULT_TIMEOUT_MS);

    if (!res.ok) {
      // throttledLogError("deleteSession failed:", res.status);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("deleteSession timeout/abort:", sessionId);
      return null;
    }
    throttledLogError("deleteSession error:", err);
    return null;
  } finally {
    try { controller.abort(); } catch {}
  }
}

// ---------------------- UPDATE SESSION TITLE ----------------------
export async function updateSessionTitle(sessionId: string, newTitle: string, userId: string | number) {
  if (!sessionId) {
    return null;
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/sessions/${sessionId}`,
      {
        method: "PUT",
        headers: userHeaders(userId),
        body: JSON.stringify({ title: newTitle }),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      // throttledLogError("updateSessionTitle failed:", res.status);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("updateSessionTitle timeout/abort:", sessionId);
      return null;
    }
    throttledLogError("updateSessionTitle error:", err);
    return null;
  } finally {
    try { controller.abort(); } catch {}
  }
}

// ---------------------- SEND REPORT ----------------------
export async function sendReport(message: string, userName: string, userId: string | number) {
  if (!userId) {
    return null;
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/report`,
      {
        method: "POST",
        headers: userHeaders(userId),
        body: JSON.stringify({ message, user_name: userName }),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      // throttledLogError("sendReport failed:", res.status);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("sendReport timeout/abort");
      return null;
    }
    throttledLogError("sendReport error:", err);
    return null;
  } finally {
    try { controller.abort(); } catch {}
  }
}

// ---------------------- REGENERATE ANSWER ----------------------
export async function regenerateAnswer(sessionId: string, userId?: string | number) {
  if (!sessionId) {
    return null;
  }

  const uid = userId ?? DEFAULT_USER_ID;
  if (!uid) {
    return null;
  }

  const controller = new AbortController();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/regenerate`,
      {
        method: "POST",
        headers: userHeaders(uid),
        body: JSON.stringify({ session_id: sessionId }),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      // throttledLogError("regenerateAnswer failed:", res.status);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("regenerateAnswer timeout/abort:", sessionId);
      return null;
    }
    throttledLogError("regenerateAnswer error:", err);
    return null;
  } finally {
    try { controller.abort(); } catch {}
  }
}


export interface FolderContentsResponse {
  folderId: number | string;
  folderName: string;
  folders: Array<{ folderId: number | string; folderName: string }>;
  documents: Array<{ documentId: number | string; documentName: string }>;
}

export async function getFolderContents(folderId?: string | number): Promise<FolderContentsResponse> {
  if (folderId === undefined || folderId === null) {
    folderId = 1; // default ROOT folder ID
  }

  const controller = new AbortController();

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  if (!token) {
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  try {
    const url = `${BASE_URL_FOLDERS}/${encodeURIComponent(folderId)}/contents`;

    console.log('📦 Fetching folder contents from:', url);
    console.log('🛡 Using token:', token);

    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    const text = await res.text();
    console.log('💬 API Response:', text);

    if (!res.ok) {
      throw new Error(`getFolderContents failed (${res.status}): ${text}`);
    }

    const raw = JSON.parse(text) as FolderContentsResponse;

    const normalized: FolderContentsResponse = {
      ...raw,
      folders: Array.isArray((raw as any).folders) ? (raw as any).folders : [],
      documents: Array.isArray((raw as any).documents) ? (raw as any).documents : [],
    };

    console.log('✅ Normalized FolderContentsResponse:', normalized);

    return normalized;
  } catch (err) {
    throttledLogError("getFolderContents error:", err);
    throw err;
  } finally {
    try { controller.abort(); } catch {}
  }
}



// بالای فایل یا در یک فایل api/folders.ts جداگانه
export interface CreatedFolderResource {
  id: number;
  name: string;
  parent?: string | null;
  children: string[];        // طبق سند: array of strings
  documents: string[];       // array of URLs
  createdAt: string;
}
