import React from "react";

export default function App() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-100">
      <div className="py-8 px-10 max-w-lg bg-white rounded-md shadow-lg">
        <h1 className="text-4xl font-extrabold text-center mb-6 tracking-tight text-gray-800">Welcome Back!</h1>
        <form>
          <div className="mb-5">
            <label htmlFor="email" className="block text-base font-medium text-gray-700 mb-3">Email address</label>
            <input type="email" id="email" className="w-full bg-gray-50 border border-gray-300 rounded-md px-4 py-3 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder:text-gray-400" placeholder="you@example.com" />
          </div>
          <div className="mb-5">
            <label htmlFor="password" className="block text-base font-medium text-gray-700 mb-3">Password</label>
            <input type="password" id="password" className="w-full bg-gray-50 border border-gray-300 rounded-md px-4 py-3 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder:text-gray-400" placeholder="Enter your password" />
          </div>
          <div className="flex items-center justify-end mb-5">
            <a href="#" className="text-blue-500 text-xs hover:underline">Forgot password?</a>
          </div>
          <button type="submit" className="w-full bg-blue-500 text-white font-bold text-sm py-3 rounded-md hover:bg-blue-600 transition-all duration-200">Sign In</button>
        </form>
      </div>
    </div>
  );
}