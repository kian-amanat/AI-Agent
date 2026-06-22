'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, LogIn, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // TODO: Implement actual login logic
      await new Promise((resolve) => setTimeout(resolve, 800));
      // On success, redirect to home
      router.push('/');
    } catch (err) {
      setError('Invalid credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.form
      className="w-full max-w-4xl h-[500px] rounded-3xl shadow-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl flex overflow-hidden relative group"
      autoComplete="off"
      onSubmit={handleSubmit}
      spellCheck={false}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Liquid Glass Decorative Side */}
      <div className="hidden md:flex w-2/5 flex-col items-center justify-center p-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#ff8a3d]/20 via-[#ff5e4d]/10 to-[#ff2d2d]/5" />
        <div className="absolute -top-10 -left-10 w-40 h-40 bg-[#ff8a3d]/30 rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-[#ff2d2d]/30 rounded-full blur-3xl animate-pulse delay-700" />
        
        <div className="relative z-10 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 mb-4 shadow-[0_8px_32px_rgba(255,138,61,0.2)] backdrop-blur-md">
            <Sparkles className="h-8 w-8 text-[#ff8a3d]" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Welcome Back</h2>
          <p className="text-sm text-white/60">Sign in to access your personalized dashboard and continue your journey.</p>
        </div>
      </div>

      {/* Form Side */}
      <div className="w-full md:w-3/5 p-8 md:p-12 flex flex-col justify-center relative z-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-white tracking-tight">Sign in</h1>
          <p className="text-sm text-white/50 mt-2">Enter your credentials to continue</p>
        </div>

        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: 1, y: 0 }} 
            className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-200 text-sm"
          >
            {error}
          </motion.div>
        )}

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-sm text-white/70 font-medium px-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/50 focus:outline-none focus:ring-1 focus:ring-[#ff8a3d]/30 transition-all duration-300"
              placeholder="you@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={submitting}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm text-white/70 font-medium px-1">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 pr-10 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/50 focus:outline-none focus:ring-1 focus:ring-[#ff8a3d]/30 transition-all duration-300"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={submitting}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          <motion.button
            whileHover={{ scale: 1.02, boxShadow: "0 0 20px rgba(255,138,61,0.3)" }}
            whileTap={{ scale: 0.98 }}
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-xl bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d] p-3.5 text-sm font-semibold text-white shadow-lg shadow-orange-500/20 transition-all duration-300 hover:from-[#ff9a4d] hover:to-[#ff6e5d] disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              >
                <LogIn className="h-5 w-5" />
              </motion.div>
            ) : (
              <LogIn className="h-5 w-5" />
            )}
            {submitting ? 'Signing in...' : 'Sign In'}
          </motion.button>
        </div>

        <div className="mt-8 text-center text-sm text-white/40">
          Don't have an account?{' '}
          <a href="/signup" className="text-[#ff8a3d] hover:text-[#ff9a4d] font-medium transition-colors">
            Create one
          </a>
        </div>
      </div>
    </motion.form>
  );
}