import React from "react";

export default function App() {
  return (
    <div className="min-h-screen w-full bg-white">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          {/* Logo */}
          <div className="mx-auto mb-8 flex flex-col items-center">
            <div className="h-10 w-10 rounded-full border border-gray-200 bg-white shadow-sm flex items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-gray-800"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M12 2.75l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.9l-5.2 2.86.99-5.79-4.21-4.1 5.82-.85L12 2.75z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="mt-1 text-[10px] font-semibold text-sky-600">
              Smart Engineer
            </div>
          </div>

          <h1 className="mb-8 text-3xl font-semibold tracking-tight text-gray-900">
            Welcome Back
          </h1>

          {/* Form */}
          <form
            className="mx-auto flex w-full flex-col items-stretch gap-4"
            onSubmit={(e) => e.preventDefault()}
          >
            <input
              type="email"
              placeholder="example@gmail.com"
              className="h-12 w-full rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <input
              type="password"
              placeholder="Password"
              className="h-12 w-full rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />

            <button
              type="submit"
              className="mt-1 h-12 w-full rounded-md bg-blue-300 text-sm font-medium text-white shadow-sm hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              Log In
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}