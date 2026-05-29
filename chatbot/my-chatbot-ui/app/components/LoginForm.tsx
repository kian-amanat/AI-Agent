import React from 'react';
import { motion } from 'framer-motion';

export default function LoginForm() {
  return (
    <form className="flex flex-col gap-7 font-sans">
      <div className="flex flex-col gap-2">
        <label
          className="text-sm font-medium text-white/80"
          htmlFor="email"
        >
          Email
        </label>
        <input
          className="border border-[#ff8a3d]/18 bg-white/[0.06] rounded-2xl px-3.5 py-2.5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#ff8a3d]/30 focus:border-[#ff8a3d]/40 transition-all duration-150"
          id="email"
          type="email"
          autoComplete="email"
          placeholder="Email"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          className="text-sm font-medium text-white/80"
          htmlFor="password"
        >
          Password
        </label>
        <input
          className="border border-[#ff8a3d]/18 bg-white/[0.06] rounded-2xl px-3.5 py-2.5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#ff8a3d]/30 focus:border-[#ff8a3d]/40 transition-all duration-150"
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
        />
      </div>
      <motion.button
        whileHover={{ scale: 1.035 }}
        whileTap={{ scale: 0.97 }}
        className="mt-4 flex items-center justify-center bg-gradient-to-br from-[#ff6a3d] via-[#ff4d3d] to-[#ff2d2d] border border-[#ff8a3d]/20 text-white font-semibold py-2.5 rounded-2xl shadow-[0_8px_18px_rgba(255,77,61,0.18)] transition-all duration-200 hover:shadow-[0_12px_24px_rgba(255,77,61,0.22)] focus:outline-none focus:ring-2 focus:ring-[#ff8a3d]/30 focus:ring-offset-2 disabled:opacity-50"
        type="submit"
      >
        Sign In
      </motion.button>
    </form>
  );
}