import React, { useState } from "react";

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);    // بدون type
  const [success, setSuccess] = useState(null); // بدون type

  async function handleLogin(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!email || !password) {
      setError("Email و Password را وارد کنید");
      return;
    }

    setLoading(true);
    try {
const res = await fetch("http://localhost:4000/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        // backend در صورت خطا { error: "..." } برمی‌گرداند
        throw new Error(data.error || "Login failed");
      }

      // login موفق
      setSuccess(`خوش آمدی ${data.user?.name || data.user?.email || ""}`);
      console.log("Logged in:", data);

      // اگر خواستی:
      // localStorage.setItem("token", data.token);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="flex flex-col items-center">
            <div className="h-10 w-10 rounded-full border border-gray-200 bg-white shadow-sm flex items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-gray-900"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M12 2l7.5 4.2v7.6L12 22 4.5 13.8V6.2L12 2Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M8.5 13.2c1.3 1.6 5.7 1.6 7 0M9.2 10.2h.01M14.8 10.2h.01"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="mt-1 text-[10px] font-medium text-sky-600">
              Smart Engineer
            </div>
          </div>

          <h1 className="mt-10 text-3xl font-semibold text-gray-900">
            Welcome Back
          </h1>

          {/* پیام خطا / موفقیت */}
          <div className="mt-4 h-6 text-xs text-center">
            {error && <div className="text-red-500">{error}</div>}
            {success && <div className="text-green-600">{success}</div>}
          </div>

          <form
            className="mt-4 mx-auto w-[320px] space-y-4"
            onSubmit={handleLogin}
          >
            <input
              type="email"
              placeholder="example@gmail.com"
              className="w-full h-11 rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              className="w-full h-11 rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-md bg-blue-400 text-white text-sm font-medium shadow-sm hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? "Logging in..." : "Log In"}
            </button>

            <div className="text-[10px] text-gray-400 text-left mt-1">
              برای تست: <code>test@example.com</code> / <code>password123</code>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
