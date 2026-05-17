const BASE_URL_USERS = process.env.NEXT_PUBLIC_BASE_URL_USERS ?? "https://demo.avand.ai/back/api/users";

console.log("API_USERS", BASE_URL_USERS);

// -------------------- Types --------------------
export interface UserResource {
  id: number;
  email: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  roles: string[];
  password?: string;
  passwordResetToken?: string;
  createdAt: string;
  updatedAt: string;
  uploadedDocuments: string[];
  userIdentifier: string;
}

export interface CreateUserPayload {
  email: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  roles: string[];
  password: string;
  passwordResetToken?: string;
  updatedAt?: string;
}

export interface UpdateUserPayload {
  email?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  roles?: string[];
  password?: string;
  passwordResetToken?: string;
  updatedAt?: string;
}

// -------------------- Helper: fetchWithTimeout --------------------
async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit = {},
  timeoutMs = 45_000
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
    if (err && err.name === "AbortError") {
      throw new Error("timeout_or_abort");
    }
    throw err;
  }
}

// -------------------- Helper: Get JWT Token --------------------
function getToken(): string | null {
  return typeof window !== "undefined" ? localStorage.getItem("token") : null;
}

// -------------------- Helper: User Headers --------------------
function userHeaders() {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// -------------------- GET /back/api/users --------------------
/**
 * Retrieves the collection of User resources.
 * @param page - The collection page number (default: 1)
 * @returns Array of users or empty array on failure
 */
export async function getUsers(page: number = 1): Promise<UserResource[]> {
  const controller = new AbortController();
  const token = getToken();

  if (!token) {
    console.error("[getUsers] JWT token not found.");
    return [];
  }

  try {
    const url = `${BASE_URL_USERS}?page=${encodeURIComponent(String(page || 1))}`;
    console.log("[getUsers] Fetching from:", url);

    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: userHeaders(),
        signal: controller.signal,
      },
      45_000
    );

    const text = await res.text().catch(() => "");
    console.log("[getUsers] Response status:", res.status);

    if (!res.ok) {
      console.error(`[getUsers] Failed (${res.status}):`, text);
      return [];
    }

    try {
      const json = JSON.parse(text) as UserResource[];
      if (!Array.isArray(json)) {
        console.error("[getUsers] Response is not an array:", json);
        return [];
      }
      console.log("[getUsers] Success - loaded", json.length, "users");
      return json;
    } catch (parseErr) {
      console.error("[getUsers] JSON parse failed:", parseErr);
      return [];
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[getUsers] Timeout/abort");
      return [];
    }
    console.error("[getUsers] Error:", err);
    return [];
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}

// -------------------- POST /back/api/users --------------------
/**
 * Creates a new User resource.
 * @param payload - User creation payload
 * @returns Created user resource or throws error
 */


export async function createUser(payload: CreateUserPayload): Promise<UserResource> {
  if (!payload.email || !payload.password || !payload.firstName || !payload.lastName) {
    throw new Error("Missing required fields: email, password, firstName, lastName");
  }

  const controller = new AbortController();
  const token = getToken();

  if (!token) {
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  try {
    console.log("[createUser] Creating user:", payload.email);

    const res = await fetchWithTimeout(
      BASE_URL_USERS,
      {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
      45_000
    );

    const text = await res.text().catch(() => "");
    console.log("[createUser] Response status:", res.status);

    if (!res.ok) {
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[createUser] API error:", res.status, msg);
      throw new Error(`createUser failed (${res.status}): ${msg}`);
    }

    try {
      const json = JSON.parse(text) as UserResource;
      console.log("[createUser] Success - created user:", json.id);
      return json;
    } catch (parseErr) {
      console.error("[createUser] JSON parse failed:", parseErr);
      throw new Error("createUser: invalid JSON response");
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[createUser] Timeout/abort");
      throw new Error("timeout_or_abort");
    }
    console.error("[createUser] Error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}

// -------------------- GET /back/api/users/{id} --------------------
/**
 * Retrieves a specific User resource by ID.
 * @param id - User identifier
 * @returns User resource or null on failure
 */
export async function getUser(id: string | number): Promise<UserResource | null> {
  if (id === undefined || id === null || String(id).trim() === "") {
    console.error("[getUser] User id is required.");
    return null;
  }

  const controller = new AbortController();
  const token = getToken();

  if (!token) {
    console.error("[getUser] JWT token not found.");
    return null;
  }

  try {
    const url = `${BASE_URL_USERS}/${encodeURIComponent(String(id))}`;
    console.log("[getUser] Fetching user:", id);

    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: userHeaders(),
        signal: controller.signal,
      },
      45_000
    );

    const text = await res.text().catch(() => "");
    console.log("[getUser] Response status:", res.status);

    if (!res.ok) {
      console.error(`[getUser] Failed (${res.status}):`, text);
      return null;
    }

    try {
      const json = JSON.parse(text) as UserResource;
      console.log("[getUser] Success - loaded user:", json.id);
      return json;
    } catch (parseErr) {
      console.error("[getUser] JSON parse failed:", parseErr);
      return null;
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[getUser] Timeout/abort");
      return null;
    }
    console.error("[getUser] Error:", err);
    return null;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}

// -------------------- PATCH /back/api/users/{id} --------------------
/**
 * Updates a User resource.
 * @param id - User identifier
 * @param payload - Partial user update payload
 * @returns Updated user resource or throws error
 */


export async function updateUser(
  id: string | number,
  payload: UpdateUserPayload
): Promise<UserResource> {
  if (id === undefined || id === null || String(id).trim() === "") {
    throw new Error("User id is required.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object.");
  }

  const controller = new AbortController();
  const token = getToken();

  if (!token) {
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  try {
    const url = `${BASE_URL_USERS}/${encodeURIComponent(String(id))}`;
    console.log("[updateUser] Updating user:", id, "with payload:", payload);

    const res = await fetchWithTimeout(
      url,
      {
        method: "PATCH",
        headers: {
          ...userHeaders(),
          "Content-Type": "application/merge-patch+json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
      45_000
    );

    const text = await res.text().catch(() => "");
    console.log("[updateUser] Response status:", res.status);

    if (!res.ok) {
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[updateUser] API error:", res.status, msg);
      throw new Error(`updateUser failed (${res.status}): ${msg}`);
    }

    try {
      const json = JSON.parse(text) as UserResource;
      console.log("[updateUser] Success - updated user:", json.id);
      return json;
    } catch (parseErr) {
      console.error("[updateUser] JSON parse failed:", parseErr);
      throw new Error("updateUser: invalid JSON response");
    }
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[updateUser] Timeout/abort");
      throw new Error("timeout_or_abort");
    }
    console.error("[updateUser] Error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}




// -------------------- DELETE /back/api/users/{id} --------------------
/**
 * Removes a User resource.
 * @param id - User identifier
 * @returns true on success or throws error
 */
export async function deleteUser(id: string | number): Promise<boolean> {
  if (id === undefined || id === null || String(id).trim() === "") {
    throw new Error("User id is required.");
  }

  const controller = new AbortController();
  const token = getToken();

  if (!token) {
    throw new Error("JWT token not found. لطفا ابتدا وارد شوید.");
  }

  try {
    const url = `${BASE_URL_USERS}/${encodeURIComponent(String(id))}`;
    console.log("[deleteUser] Deleting user:", id);

    const res = await fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: userHeaders(),
        signal: controller.signal,
      },
      45_000
    );

    console.log("[deleteUser] Response status:", res.status);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      console.error("[deleteUser] API error:", res.status, msg);
      throw new Error(`deleteUser failed (${res.status}): ${msg}`);
    }

    console.log("[deleteUser] Success - deleted user:", id);
    return true;
  } catch (err: any) {
    if (err && err.message === "timeout_or_abort") {
      console.error("[deleteUser] Timeout/abort");
      throw new Error("timeout_or_abort");
    }
    console.error("[deleteUser] Error:", err);
    throw err;
  } finally {
    try {
      controller.abort();
    } catch {}
  }
}
