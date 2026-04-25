import React from "react";

export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-md mx-auto px-4">
        <div className="flex justify-center mb-10">
          {/* Placeholder for small triangle logo */}
          <div className="w-4 h-4 border-l-8 border-b-8 border-white rotate-45" />
        </div>

        <div className="bg-black/40 border border-gray-800 rounded-2xl px-6 py-8 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <h1 className="text-center text-2xl font-medium text-white">
            Log in to Vercel
          </h1>

          <div className="mt-6 space-y-3">
            <input
              type="email"
              placeholder="Email Address"
              className="w-full rounded-xl border border-gray-800 bg-black px-3 py-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            />

            <button
              className="w-full rounded-xl bg-white py-2 text-base font-medium text-black hover:bg-zinc-100 transition"
            >
              Continue with Email
            </button>
          </div>

          <div className="mt-6 space-y-3">
            <button className="w-full flex justify-center gap-2 rounded-xl border border-gray-700 bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 transition">
              <span>Continue with GitHub</span>
              <span className="ml-auto mr-1 rounded-full bg-gray-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
                Last Used
              </span>
            </button>
            <button className="w-full rounded-xl border border-gray-700 bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 transition">
              <span className="flex justify-center items-center gap-2">
                Continue with Google
              </span>
            </button>
            <button className="w-full rounded-xl border border-gray-700 bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 transition">
              Continue with Apple
            </button>
            <button className="w-full rounded-xl border border-gray-700 bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 transition">
              Continue with SAML SSO
            </button>
            <button className="w-full rounded-xl border border-gray-700 bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 transition">
              Continue with Passkey
            </button>
          </div>

          <button className="mt-6 w-full text-center text-xs text-gray-400 hover:text-gray-200">
            Show other options
          </button>

          <p className="mt-4 text-center text-xs text-gray-400">
            Don&apos;t have an account?{" "}
            <button className="text-white underline-offset-2 hover:underline">
              Sign Up
            </button>
          </p>
        </div>

        <div className="mt-6 flex justify-center gap-4 text-xs text-gray-400">
          <button className="hover:text-gray-200">Terms</button>
          <button className="hover:text-gray-200">Privacy Policy</button>
        </div>
      </div>
    </div>
  );
}