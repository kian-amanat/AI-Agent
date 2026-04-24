import React from "react";

export default function App() {
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

          <form className="mt-8 mx-auto w-[320px] space-y-4">
            <input
              type="email"
              placeholder="example@gmail.com"
              className="w-full h-11 rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
            />
            <input
              type="password"
              placeholder="Password"
              className="w-full h-11 rounded-md border border-gray-200 bg-white px-4 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
            />

            <button
              type="button"
              className="w-full h-11 rounded-md bg-blue-400 text-white text-sm font-medium shadow-sm hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              Log In
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}