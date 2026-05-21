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

/**
 * Create a new folder via API.
 * - name: required
 * - parent: optional (folder id or string). If omitted, backend should create under root.
 */
export async function createFolder(
  name: string,
  parent?: string | number | null,
): Promise<CreatedFolderResource> {
  if (!name || String(name).trim() === "") {
    throw new Error("Folder name is required.");
  }

  const controller = new AbortController();
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  if (!token) {
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  try {
    const url = `${BASE_URL_FOLDERS}`;
    const body: any = { name: String(name).trim() };

    // ✅ فقط اگر parent ارسال شده بود، parent را اضافه کن
    if (parent !== undefined && parent !== null) {
      const asStr = String(parent).trim();

      if (asStr && asStr !== "1") {
        // ✅ اگر از قبل IRI کامل است، دست نزن
        if (asStr.startsWith("/back/api/folders/")) {
          body.parent = asStr;
        } else {
          // ✅ اگر فقط id / عدد است، اینجا IRI بساز
          body.parent = `/back/api/folders/${asStr}`;
        }
      }
      // اگر asStr خالی بود یا "1" بود، parent را در body نگذار (یعنی root)
    }

    console.log("📤 Creating folder:", JSON.stringify(body), "→", url);

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    const text = await res.text();
    console.log("💬 createFolder response:", res.status, text);

    if (!res.ok) {
      console.error(
        "createFolder failed status",
        res.status,
        "url",
        url,
        "body",
        JSON.stringify(body),
        "responseText",
        text
      );

      // 🔁 fallback: امتحان بدون parent فقط اگر parent داشتیم
      if (res.status === 500 && parent) {
        console.warn(
          "⚠️ Folder creation with parent failed. Trying without parent field..."
        );
        const fallbackBody = { name: String(name).trim() };
        const fallbackRes = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(fallbackBody),
            signal: controller.signal,
          },
          DEFAULT_TIMEOUT_MS
        );

        const fallbackText = await fallbackRes.text();
        if (fallbackRes.ok) {
          console.log(
            "✅ Fallback succeeded (created without parent):",
            fallbackText
          );
          const json = JSON.parse(fallbackText) as CreatedFolderResource;
          return json;
        } else {
          console.error(
            "❌ Fallback also failed:",
            fallbackRes.status,
            fallbackText
          );
        }
      }

      let msg = text || `createFolder failed (${res.status})`;
      throw new Error(msg);
    }

    const json = JSON.parse(text) as CreatedFolderResource;
    return json;
  } catch (err) {
    console.error("createFolder error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}



export interface DocumentResource {
  id: number;
  title: string;
  description: string;
  file: string;
  project: { id: number; name: string } | null;
  folder: { id: number; name: string } | null;
  tags: string[];
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  isIndexed: boolean;
}

/**
 * GET /back/api/documents
 * - page: optional (default = 1)
 * - returns array of DocumentResource or empty array on failure
 */
export async function getDocuments(page: number = 1): Promise<DocumentResource[]> {
  const controller = new AbortController();

  // Get JWT from localStorage
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (!token) {
    throttledLogError("getDocuments: JWT token not found.");
    return [];
  }

  try {
    const url = `${BASE_URL_DOCS}?page=${encodeURIComponent(String(page || 1))}`;

    // Debug logs (can remove later)
    // console.log("📦 Fetching documents from:", url);

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

    const text = await res.text().catch(() => "");
    // console.log("💬 getDocuments response:", res.status, text);

    if (!res.ok) {
      throttledLogError(`getDocuments failed (${res.status}):`, text);
      return [];
    }

    try {
      const json = JSON.parse(text) as DocumentResource[];
      // Basic sanity check: ensure we return an array
      if (!Array.isArray(json)) {
        throttledLogError("getDocuments: response is not an array", json);
        return [];
      }
      return json;
    } catch (parseErr) {
      throttledLogError("getDocuments: JSON parse failed:", parseErr, "raw:", text);
      return [];
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("getDocuments timeout/abort");
      return [];
    }
    throttledLogError("getDocuments error:", err);
    return [];
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}


/**
 * Create a new Document resource via backend API
 * POST https://demo.avand.ai/back/api/documents
 *
 * Request body (example shape accepted by backend):
 * {
 *   title?: string,
 *   description?: string,
 *   file?: string,
 *   project?: { name?: string } | null,
 *   folder?: string | null,
 *   tags?: string[] | null
 * }
 *
 * Returns DocumentResource on success, or null on failure.
 */
// create document with multipart (API Platform style)
export async function createDocument(payload: {
  title: string;
  file: File;
  folder: string | number;
  description?: string;
}) {
  try {
    console.log("📤 createDocument debug payload:", payload);

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    if (!token) {
      throw new Error("JWT token not found");
    }

    // normalize folder to IRI
    const folderId =
      typeof payload.folder === "string"
        ? payload.folder.replace(/^\/+/, "").replace(/^folders\//, "")
        : String(payload.folder);

    const folderIri = `/folders/${folderId}`;

    const formData = new FormData();
    formData.append("file", payload.file);
    formData.append("folder", folderIri);
    formData.append("title", payload.title || payload.file.name);

    if (payload.description) {
      formData.append("description", payload.description);
    }

    console.log("📦 formData folder:", folderIri);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL_DOCS}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}

    console.log("📥 createDocument response:", res.status, parsed || text);

    if (!res.ok) {
      throw new Error(
        parsed?.detail ||
          parsed?.message ||
          `createDocument failed (${res.status})`
      );
    }

    return parsed;
  } catch (err) {
    console.error("❌ createDocument error:", err);
    throw err;
  }
}


export async function downloadDocument(id: string) {
  try {
    console.log("📤 downloadDocument debug id:", id);

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    if (!token) {
      throw new Error("JWT token not found");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(
  `${process.env.NEXT_PUBLIC_BASE_URL_DOCS}/${id}/download`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/octet-stream",
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    console.log("📥 downloadDocument response status:", res.status);

    if (res.status === 403) {
      throw new Error("Forbidden: you don't have access to this document");
    }

    if (res.status === 404) {
      throw new Error("Document not found");
    }

    if (!res.ok) {
      throw new Error(`downloadDocument failed (${res.status})`);
    }

    // extract filename from Content-Disposition header if available
    const disposition = res.headers.get("Content-Disposition");
    let filename = `document-${id}`;
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match?.[1]) {
        filename = match[1].replace(/['"]/g, "");
      }
    }

    const blob = await res.blob();

    // trigger browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    return { success: true, filename };
  } catch (err) {
    console.error("❌ downloadDocument error:", err);
    throw err;
  }
}



export async function deleteFolder(id: string | number) {
  console.log("[deleteFolder] called with id:", id);
  console.log("[deleteFolder] BASE_URL_FOLDERS:", BASE_URL_FOLDERS);

  // sanity checks
  if (id === undefined || id === null || String(id).trim() === "") {
    console.error("[deleteFolder] ERROR: Folder id is required.");
    throw new Error("Folder id is required.");
  }

  // JWT from localStorage (همان الگوی updateDocument)
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  console.log(
    "[deleteFolder] token present?:",
    !!token,
    token ? "trimmed_len=" + String(token).length : null
  );

  if (!token) {
    console.error("[deleteFolder] ERROR: JWT token not found");
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  const controller = new AbortController();

  try {
    const url = `${BASE_URL_FOLDERS}/${encodeURIComponent(String(id))}`;
    console.log("🗑 deleteFolder ->", url);

    const res = await fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: {
          Accept: "*/*",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    // این endpoint معمولا 204 بدون بدنه می‌دهد
    const text = await res.text().catch(() => "");
    console.log(
      "[deleteFolder] response status:",
      res.status,
      "raw text:",
      text
    );

    if (!res.ok) {
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("[deleteFolder] Failed to parse error response:", e);
      }
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[deleteFolder] API error:", res.status, msg);
      throw new Error(`deleteFolder failed (${res.status}): ${msg}`);
    }

    return true;
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[deleteFolder] TIMEOUT/ABORT for id:", id);
      throttledLogError("deleteFolder timeout/abort:", id);
      throw new Error("timeout_or_abort");
    }
    console.error("[deleteFolder] ERROR THROWN:", err);
    throttledLogError("deleteFolder error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch (e) {
      console.error("[deleteFolder] Error aborting controller:", e);
    }
  }
}


export async function deleteDocument(id: string | number) {
  console.log("[deleteDocument] called with id:", id);
  console.log("[deleteDocument] BASE_URL_DOCUMENTS:", BASE_URL_DOCS);

  // sanity checks
  if (id === undefined || id === null || String(id).trim() === "") {
    console.error("[deleteDocument] ERROR: Document id is required.");
    throw new Error("Document id is required.");
  }

  // JWT from localStorage (همان الگوی deleteFolder / updateDocument)
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  console.log(
    "[deleteDocument] token present?:",
    !!token,
    token ? "trimmed_len=" + String(token).length : null
  );

  if (!token) {
    console.error("[deleteDocument] ERROR: JWT token not found");
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  const controller = new AbortController();

  try {
    // طبق Swagger: DELETE /back/api/documents/{id}
    const url = `${BASE_URL_DOCS}/${encodeURIComponent(String(id))}`;
    console.log("🗑 deleteDocument ->", url);

    const res = await fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: {
          Accept: "*/*", // طبق curl نمونه
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    // این endpoint معمولا 204 بدون بدنه می‌دهد
    const text = await res.text().catch(() => "");
    console.log(
      "[deleteDocument] response status:",
      res.status,
      "raw text:",
      text
    );

    if (!res.ok) {
      // برای 403/404 و سایر خطاها، سعی می‌کنیم بدنه را parse کنیم
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("[deleteDocument] Failed to parse error response:", e);
      }
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[deleteDocument] API error:", res.status, msg);
      throw new Error(`deleteDocument failed (${res.status}): ${msg}`);
    }

    // 204 یا هر کد 2xx دیگر
    return true;
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[deleteDocument] TIMEOUT/ABORT for id:", id);
      throttledLogError("deleteDocument timeout/abort:", id);
      throw new Error("timeout_or_abort");
    }
    console.error("[deleteDocument] ERROR THROWN:", err);
    throttledLogError("deleteDocument error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch (e) {
      console.error("[deleteDocument] Error aborting controller:", e);
    }
  }
}

// lib/api.ts

// api.ts

// api.ts

export async function updateFolder(
  id: string | number,
  payload: { name?: string } // add other PATCHable fields if needed
) {
  console.log("[updateFolder] called with id:", id, "payload:", payload);
  console.log("[updateFolder] BASE_URL_FOLDERS:", BASE_URL_FOLDERS);

  // sanity checks
  if (id === undefined || id === null || String(id).trim() === "") {
    console.error("[updateFolder] ERROR: Folder id is required.");
    throw new Error("Folder id is required.");
  }

  // JWT from localStorage (same pattern as deleteFolder / updateDocument)
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  console.log(
    "[updateFolder] token present?:",
    !!token,
    token ? "trimmed_len=" + String(token).length : null
  );

  if (!token) {
    console.error("[updateFolder] ERROR: JWT token not found");
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  const controller = new AbortController();

  try {
    const url = `${BASE_URL_FOLDERS}/${encodeURIComponent(String(id))}`;
    console.log("✏️ updateFolder ->", url);

    const res = await fetchWithTimeout(
      url,
      {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/merge-patch+json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    const text = await res.text().catch(() => "");
    console.log(
      "[updateFolder] response status:",
      res.status,
      "raw text:",
      text
    );

    if (!res.ok) {
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("[updateFolder] Failed to parse error response:", e);
      }
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[updateFolder] API error:", res.status, msg);
      throw new Error(`updateFolder failed (${res.status}): ${msg}`);
    }

    // API probably returns the updated folder object
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      console.error("[updateFolder] Failed to parse success response:", e);
    }

    return data;
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[updateFolder] TIMEOUT/ABORT for id:", id);
      throttledLogError("updateFolder timeout/abort:", id);
      throw new Error("timeout_or_abort");
    }
    console.error("[updateFolder] ERROR THROWN:", err);
    throttledLogError("updateFolder error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch (e) {
      console.error("[updateFolder] Error aborting controller:", e);
    }
  }
}



/**
 * PATCH /back/api/documents/{id} for archiving
 * - content-type: application/merge-patch+json
 * - patchPayload: object with fields to update (title, description, folder, tags, isArchived, ...)
 *
 * Returns the updated Document resource (parsed JSON) or throws an Error on failure.
 */
export async function updateDocument(id: string | number, patchPayload: Record<string, any>) {
  // very early sanity logs (will appear in browser console if called from client)
  console.log("[updateDocument] called with id:", id, "payload:", patchPayload);
  console.log("[updateDocument] BASE_URL_DOCS:", BASE_URL_DOCS);

  if (id === undefined || id === null || String(id).trim() === "") {
    console.error("[updateDocument] ERROR: Document id is required.");
    throw new Error("Document id is required.");
  }
  if (!patchPayload || typeof patchPayload !== "object") {
    console.error("[updateDocument] ERROR: patchPayload must be an object.");
    throw new Error("patchPayload must be an object.");
  }

  // Get JWT from localStorage (same pattern used in other folder/document helpers)
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  console.log("[updateDocument] token present?:", !!token, token ? "trimmed_len=" + String(token).length : null);

  if (!token) {
    // throw AFTER logging so you can see this in console
    console.error("[updateDocument] ERROR: JWT token not found");
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  const controller = new AbortController();

  try {
    const url = `${BASE_URL_DOCS}/${encodeURIComponent(String(id))}`;
    console.log("🔧 updateDocument ->", url, patchPayload);

    const res = await fetchWithTimeout(
      url,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/merge-patch+json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(patchPayload),
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    const text = await res.text().catch(() => "");
    console.log("[updateDocument] response status:", res.status, "raw text:", text);

    if (!res.ok) {
      let parsed: any = text;
      try { 
        parsed = JSON.parse(text); 
      } catch (e) {
        console.error("[updateDocument] Failed to parse error response:", e);
      }
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      // include parsed body in error message for easier debugging
      console.error("[updateDocument] API error:", res.status, msg);
      throw new Error(`updateDocument failed (${res.status}): ${msg}`);
    }

    // parse success body
    let json: any = null;
    try {
      json = JSON.parse(text);
      console.log("[updateDocument] success parsed:", json);
      return json;
    } catch (parseErr) {
      console.error("[updateDocument] JSON parse failed:", parseErr, "raw:", text);
      throttledLogError("updateDocument: JSON parse failed:", parseErr, "raw:", text);
      throw new Error("updateDocument: invalid JSON response");
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[updateDocument] TIMEOUT/ABORT for id:", id);
      throttledLogError("updateDocument timeout/abort:", id);
      throw new Error("timeout_or_abort");
    }
    console.error("[updateDocument] ERROR THROWN:", err);
    throttledLogError("updateDocument error:", err);
    throw err;
  } finally {
    try { 
      controller.abort(); 
    } catch (e) {
      console.error("[updateDocument] Error aborting controller:", e);
    }
  }
}
/**
 * GET /back/api/documents/archived get archived documents
 * - page: optional (default = 1)
 * - returns array of DocumentResource or empty array on failure
 */
export async function getArchivedDocuments(page: number = 1): Promise<DocumentResource[]> {
  const controller = new AbortController();

  // Get JWT from localStorage (consistent with other helpers)
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  if (!token) {
    throttledLogError("getArchivedDocuments: JWT token not found.");
    return [];
  }

  try {
    const url = `${BASE_URL_DOCS}/archived?page=${encodeURIComponent(String(page || 1))}`;

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

    const text = await res.text().catch(() => "");

    if (!res.ok) {
      throttledLogError(`getArchivedDocuments failed (${res.status}):`, text);
      return [];
    }

    try {
      const json = JSON.parse(text) as DocumentResource[];
      if (!Array.isArray(json)) {
        throttledLogError("getArchivedDocuments: response is not an array", json);
        return [];
      }
      return json;
    } catch (parseErr) {
      throttledLogError("getArchivedDocuments: JSON parse failed:", parseErr, "raw:", text);
      return [];
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      throttledLogError("getArchivedDocuments timeout/abort");
      return [];
    }
    throttledLogError("getArchivedDocuments error:", err);
    return [];
  } finally {
    try { controller.abort(); } catch {}
  }
}

/**
 * Fallback form/multipart uploader.
 * POSTs FormData to /back/api/documents/upload with fields: title, description, file (Blob), folder
 * Returns parsed JSON or { status, body } on non-OK.
 */
export async function formUploadDocument(
  file: File,
  title?: string,
  description?: string,
  folder?: string | number | undefined
): Promise<any> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) return { error: 'no_token' };

    const fd = new FormData();
    if (title !== undefined) fd.append('title', String(title));
    if (description !== undefined) fd.append('description', String(description));
    fd.append('file', file, file.name);
    if (folder !== undefined && folder !== null) {
      // API expects folder IRI like "/folders/1"
      const folderIri =
        typeof folder === 'number'
          ? `/folders/${folder}`
          : (String(folder).startsWith('/') ? String(folder) : `/folders/${String(folder)}`);
      fd.append('folder', folderIri);
    }

    // debug log
    // eslint-disable-next-line no-console
    console.log('🔁 formUploadDocument -> POST /back/api/documents/upload', { filename: file.name, title, folder });

    const res = await fetch(`${BASE_URL_DOCS}/upload`, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type for FormData; browser will set boundary.
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: fd,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      try {
        const parsed = text ? JSON.parse(text) : text;
        // eslint-disable-next-line no-console
        console.warn('⚠️ formUploadDocument non-ok response', res.status, parsed);
        return { status: res.status, body: parsed };
      } catch {
        // eslint-disable-next-line no-console
        console.warn('⚠️ formUploadDocument non-ok text', res.status, text);
        return { status: res.status, body: text };
      }
    }
    try {
      const json = JSON.parse(text);
      // eslint-disable-next-line no-console
      console.log('✅ formUploadDocument success', json);
      return json;
    } catch {
      // eslint-disable-next-line no-console
      console.log('✅ formUploadDocument success (non-json)', text);
      return text;
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('formUploadDocument network error', err);
    return { error: 'network_error', detail: String(err) };
  }
}



export interface FolderTableResponse {
  folderId: number | string;
  folderName: string;
  folders: Array<any>;    // keep flexible because Swagger example uses additionalProp{N}
  documents: Array<any>;  // detailed document objects — use a stricter interface if available
}

/**
 * GET /back/api/folders/{id}/table
 * - returns immediate child folders and documents with detailed information
 */
export async function getFolderTable(folderId: string | number): Promise<FolderTableResponse | null> {
  if (folderId === undefined || folderId === null || String(folderId).trim() === '') {
    throw new Error('Folder id is required. شناسه‌ی پوشه لازم است.');
  }

  // Get JWT from localStorage
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  if (!token) {
    throttledLogError('getFolderTable: JWT token not found.');
    return null;
  }

  const controller = new AbortController();
  try {
    const url = `${BASE_URL_FOLDERS}/${encodeURIComponent(String(folderId))}/table`;

    // Debug log (optional)
    // console.log('📦 Fetching folder table from:', url);

    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
      DEFAULT_TIMEOUT_MS
    );

    const text = await res.text().catch(() => '');

    if (!res.ok) {
      // if backend returned a structured error, log it
      throttledLogError(`getFolderTable failed (${res.status}):`, text);
      return null;
    }

    try {
      const json = JSON.parse(text) as FolderTableResponse;
      return json;
    } catch (parseErr) {
      throttledLogError('getFolderTable: JSON parse failed:', parseErr, 'raw:', text);
      return null;
    }
  } catch (err: any) {
    if (err && err.message === 'timeout_or_abort') {
      throttledLogError('getFolderTable timeout/abort');
      return null;
    }
    throttledLogError('getFolderTable error:', err);
    return null;
  } finally {
    try { controller.abort(); } catch {}
  }
}

// --- server-friendly API helpers (اضافه کنید در انتهای فایل api.ts) ---

/**
 * توجه: این توابع برای اجرا در سرور نوشته شده‌اند.
 * - token را به‌عنوان پارامتر دریافت می‌کنند (نه از localStorage).
 * - از fetchWithTimeout و throttledLogError استفاده می‌کنند (فرض بر این است که این توابع/متغیرها در بالای همین فایل تعریف شده‌اند).
 * - آدرس‌های فولدر را اگر لازم بود با پیشوند /back/api اصلاح می‌کنند (برای حل 500 در createDocument).
 */

type FetchOptions = RequestInit & { timeoutMs?: number };

async function fetchJsonWithAuth(url: string, token: string, options: FetchOptions = {}) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    // اگر لازم است 'Content-Type' را در هر تابع اضافه کنید (مثلاً برای multipart/form-data - نباید هدر را ست کنید)
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetchWithTimeout(url, { ...options, headers });
  if (!res.ok) {
    // سعی کنید خطای دقیق‌تر را استخراج کنید
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) {}
    const err = new Error(`Request failed ${res.status} ${res.statusText}: ${bodyText}`);
    throttledLogError(err);
    throw err;
  }
  // برخی پاسخ‌ها ممکن است بدون بدنه باشند
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return res.text();
}

/** اطمینان از اینکه IRI فولدر شامل پیشوند API باشد */
function ensureFolderIriHasApiPrefix(folderIri: string) {
  if (!folderIri) return folderIri;
  // اگر مسیر از نوع '/folders/1' است، تبدیل به '/back/api/folders/1'
  if (folderIri.startsWith('/back/api')) return folderIri;
  if (folderIri.startsWith('/folders')) return `/back/api${folderIri}`;
  // اگر کاربر آی‌آر‌آی کامل داد (مثلاً https://demo.avand.ai/back/api/folders/1) آن را برمی‌گردانیم
  return folderIri;
}

/** نمونه: دریافت محتوای سایدبار / فهرست فولدرها */
export async function getSidebarContents(token: string, rootFolderIri?: string) {
  try {
    const base = process.env.API_BASE_URL || 'https://demo.avand.ai';
    // اگر rootFolderIri داده شده، آن را encode و به انتهای مسیر اضافه کنید
    const path = rootFolderIri ? `/back/api/folders/${encodeURIComponent(rootFolderIri)}/children` : '/back/api/folders';
    const url = new URL(path, base).toString();
    return await fetchJsonWithAuth(url, token, { method: 'GET', timeoutMs: 15000 });
  } catch (err) {
    throttledLogError(err);
    throw err;
  }
}

/** نمونه: ایجاد فولدر در سرور */
export async function createFolderServer(token: string, parentFolderIri: string, payload: { name: string, description?: string }) {
  try {
    const base = process.env.API_BASE_URL || 'https://demo.avand.ai';
    const parentIri = ensureFolderIriHasApiPrefix(parentFolderIri);
    // فرض: API endpoint برای ایجاد زیرفولدر: POST /back/api/folders/{parentId}/children
    // اگر آیدی در IRI به صورت عدد/slug موجود است، از آن استفاده شود؛ در غیر اینصورت ممکن است نیاز به تغییر مسیر داشته باشید.
    const url = new URL(parentIri.replace('/back/api', '/back/api') , base).toString(); // حفظ الگو، ممکن است تنظیم بیشتر نیاز باشد
    // نمونه ساده: فرض می‌کنیم endpoint زیر کار می‌کند:
    // POST /back/api/folders/{parentId}/children  body: { name, description }
    const res = await fetchJsonWithAuth(url, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    return res;
  } catch (err) {
    throttledLogError(err);
    throw err;
  }
}

/** نمونه: دریافت محتویات یک فولدر (getFolderContents) */
export async function getFolderContentsServer(token: string, folderIri: string, params?: { page?: number, size?: number }) {
  try {
    const base = process.env.API_BASE_URL || 'https://demo.avand.ai';
    const folder = ensureFolderIriHasApiPrefix(folderIri);
    // اگر folder به صورت کامل IRI باشد، ممکن است نیاز به استخراج شناسه و قرار دادن در مسیر مناسب API داشته باشید.
    // این نمونه مسیر ساده‌ای را نشان می‌دهد که احتمالا باید بر اساس API واقعی شما تنظیم شود:
    const url = new URL(`/back/api/folders/${encodeURIComponent(folder)}/contents`, base);
    if (params?.page) url.searchParams.set('page', String(params.page));
    if (params?.size) url.searchParams.set('size', String(params.size));
    return await fetchJsonWithAuth(url.toString(), token, { method: 'GET', timeoutMs: 15000 });
  } catch (err) {
    throttledLogError(err);
    throw err;
  }
}

/** نمونه: آپلود سند — نسخه سرور که IRI فولدر را با پیشوند API اصلاح می‌کند */
export async function createDocumentServer(token: string, folderIri: string, file: Blob | Buffer | File, metadata?: Record<string, any>) {
  try {
    const base = process.env.API_BASE_URL || 'https://demo.avand.ai';
    const folder = ensureFolderIriHasApiPrefix(folderIri);
    // فرض می‌کنیم endpoint آپلود: POST /back/api/documents/upload?folderIri=...
    const url = new URL('/back/api/documents/upload', base);
    url.searchParams.set('folderIri', folder);

    const form = new FormData();
    // اگر file از نوع Node Buffer استفاده می‌کنید، در محیط سرور باید از form-data package استفاده کنید.
    // اینجا نمونه برای browser-like FormData (اگر در سرور node هستید، ممکن است نیاز به تغییر باشد).
    form.append('file', file as any);
    if (metadata) form.append('metadata', JSON.stringify(metadata));

    // توجه: در صورت استفاده از FormData، نباید هدر Content-Type را دستی ست کنید (fetch آن را خودش می‌سازد)
    const res = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        body: form as any,
        headers: { 'Authorization': `Bearer ${token}` }, // فقط Authorization اینجا
      },
      60000
    );

    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (_) {}
      const err = new Error(`Upload failed: ${res.status} ${res.statusText} ${txt}`);
      throttledLogError(err);
      throw err;
    }
    return await res.json();
  } catch (err) {
    throttledLogError(err);
    throw err;
  }
}

/** نمونه: دریافت اسناد آرشیو شده */
export async function getArchivedDocumentsServer(token: string, params?: { page?: number, size?: number }) {
  try {
    const base = process.env.API_BASE_URL || 'https://demo.avand.ai';
    const url = new URL('/back/api/documents/archived', base);
    if (params?.page) url.searchParams.set('page', String(params.page));
    if (params?.size) url.searchParams.set('size', String(params.size));
    return await fetchJsonWithAuth(url.toString(), token, { method: 'GET', timeoutMs: 15000 });
  } catch (err) {
    throttledLogError(err);
    throw err;
  }
}
