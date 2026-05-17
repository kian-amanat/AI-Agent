// services/auth.ts
// یک ماژول واحد برای لاگین / ثبت / توکن و گرفتن یوزر
// توجه: اگر با Next.js کار می‌کنید، در .env.local از NEXT_PUBLIC_BASE_URL استفاده کنید.

const BASE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? process.env.BASE_URL_PURE ?? "https://demo.avand.ai")
  .replace(/\/+$/, ""); // حذف اسلش انتهایی اگر بود

const AUTH_BASE = `${BASE_URL}/back/api/auth`;
const TOKEN_KEY = "auth_token";

const DEFAULT_USER_ID =
  typeof window !== "undefined" ? (localStorage.getItem("user_id") ?? "") : "";

// ----------------------
// USER HEADERS (SAFE)
// ----------------------
function userHeaders(userId?: string | number | null) {
  const sid =
    userId !== undefined && userId !== null && userId !== ""
      ? String(userId)
      : String(DEFAULT_USER_ID || "");

  return {
    "Content-Type": "application/json",
    "X-User-Id": sid,
    "user-id": sid,
    "user_id": sid,
  };
}

// ----------------------
// AUTH HEADERS SAFE
// ----------------------
function authHeaders(token?: string | null, userId?: string | number | null): Record<string, string> {
  const headers: Record<string, string> = {};

  if (userId !== undefined && userId !== null && userId !== "") {
    Object.assign(headers, userHeaders(String(userId)));
  } else {
    Object.assign(headers, userHeaders());
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

// ----------------------
// TOKEN HELPERS
// ----------------------
export function saveToken(token: string | null) {
  try {
    if (typeof window === "undefined") return;
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch (err) {
    // ignore
  }
}

export function getToken(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(TOKEN_KEY);
  } catch (err) {
    return null;
  }
}

export function logout() {
  saveToken(null);
}

// utility: safe JSON parse with content-type check
async function safeJson(res: Response) {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${e}`);
    }
  } else {
    // برگشت HTML یا متن دیگر — برای دیباگ بهتر آن را برمی‌گردانیم / پرتاب می‌کنیم
    throw new Error(`Expected JSON but got ${ct}: ${text.substring(0, 1000)}`);
  }
}

// ----------------------
// LOGIN
// ----------------------
export async function login(email: string, password: string) {
  try {
    const res = await fetch(`${AUTH_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

if (!res.ok) {
  const body = await res.text();
  let message = "خطای ناشناخته. لطفاً دوباره تلاش کنید.";

  switch (res.status) {
    case 400:
      message = "درخواست نامعتبر است. لطفاً اطلاعات را بررسی کنید.";
      break;
    case 401:
      message = "ایمیل یا رمز عبور اشتباه است.";
      break;
    case 403:
      message = "دسترسی شما مجاز نیست.";
      break;
    case 404:
      message = "سرویس ورود پیدا نشد.";
      break;
    case 408:
      message = "زمان پاسخ‌گویی سرور تمام شد.";
      break;
    case 429:
      message = "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد تلاش کنید.";
      break;
    case 500:
      message = "خطای داخلی سرور رخ داده است.";
      break;
    case 502:
    case 503:
    case 504:
      message = "سرور موقتاً در دسترس نیست. لطفاً بعداً تلاش کنید.";
      break;
  }

  console.warn("login failed:", res.status, body);
  return {
    success: false,
    status: res.status,
    message,
    raw: body,
  };
}


    const data = await safeJson(res);
    // اگر توکن در فیلدهای متفاوت برگشت، ذخیره کن
    if (data?.token) saveToken(data.token);
    else if (data?.access_token) saveToken(data.access_token);

    return data;
  } catch (err) {
    console.error("login error:", err);
    return null;
  }
}

// ----------------------
// GET CURRENT USER
// ----------------------
export async function getCurrentUser(userId?: string | number) {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetch(`${AUTH_BASE}/me`, {
      method: "GET",
      headers: authHeaders(token, userId),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("getCurrentUser failed:", res.status, body);
      return null;
    }

    return await safeJson(res);
  } catch (err) {
    console.error("getCurrentUser error:", err);
    return null;
  }
}

// ----------------------
// REGISTER
// ----------------------
export async function register(
  payload: {
    email: string;
    password: string;
    first_name?: string;
    last_name?: string;
    phone_number?: string;
  },
  userId?: string | number
) {
  try {
    const res = await fetch(`${AUTH_BASE}/register`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("register failed:", res.status, body);
      return null;
    }

    const data = await safeJson(res);
    if (data?.token) saveToken(data.token);
    else if (data?.access_token) saveToken(data.access_token);

    return data;
  } catch (err) {
    console.error("register error:", err);
    return null;
  }
}

// ----------------------
// FORGOT REQUEST / VERIFY / RESET
// ----------------------
export async function forgotRequest(identifier: string, userId?: string | number) {
  try {
    const res = await fetch(`${AUTH_BASE}/forgot/request`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify({ identifier }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("forgotRequest failed:", res.status, body);
      return null;
    }

    return await safeJson(res);
  } catch (err) {
    console.error("forgotRequest error:", err);
    return null;
  }
}

export async function forgotVerify(token: string, code: string, userId?: string | number) {
  try {
    const res = await fetch(`${AUTH_BASE}/forgot/verify`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify({ token, code }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("forgotVerify failed:", res.status, body);
      return null;
    }

    return await safeJson(res);
  } catch (err) {
    console.error("forgotVerify error:", err);
    return null;
  }
}

export async function forgotReset(
  token: string,
  code: string,
  new_password: string,
  userId?: string | number
) {
  try {
    const res = await fetch(`${AUTH_BASE}/forgot/reset`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify({ token, code, new_password }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn("forgotReset failed:", res.status, body);
      return null;
    }

    return await safeJson(res);
  } catch (err) {
    console.error("forgotReset error:", err);
    return null;
  }
}