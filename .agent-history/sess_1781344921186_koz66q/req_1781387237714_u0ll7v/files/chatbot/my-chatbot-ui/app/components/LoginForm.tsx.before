'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, LogIn } from 'lucide-react';
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
      className="w-full max-w-md px-8 py-10 rounded-3xl shadow-2xl border border-[#ff8a3d]/20 bg-gradient-to-br from-[#ff8a3d]/10 via-[#ff5e4d]/8 to-[#ff2d2d]/6 backdrop-blur-md flex flex-col gap-7 font-sans"
      autoComplete="off"
      onSubmit={handleSubmit}
      spellCheck={false}
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="flex flex-col items-center mb-7">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#ff8a3d]/18 bg-white/[0.04] mb-2 shadow-[0_2px_8px_rgba(255,138,61,0.08)]">
          <LogIn className="h-7 w-7 text-[#ff8a3d]" />
        </div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Sign in to your account</h1>
        <p className="text-sm text-white/38 mt-1">Enter your credentials to continue</p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-sm text-white/70 font-medium px-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition"
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
            className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition w-full pr-12"
            placeholder="Your password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={submitting}
            required
          />
          <button
            type="button"
            tabIndex={-1}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80 focus:outline-none"
            onClick={() => setShowPassword(v => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        </div>
      </div>
      {error && (
        <div className="text-sm text-red-400 px-1 -mt-3">{error}</div>
      )}
      <button
        className="mt-4 flex items-center justify-center bg-gradient-to-r from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d] text-white font-semibold rounded-2xl py-2.5 px-6 shadow-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-[#ff8a3d]/40 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
        type="submit"
        disabled={submitting}
      >
        {submitting ? (
          <>
            <svg className="animate-spin mr-2 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            Signing in…
          </>
        ) : (
          'Sign in'
        )}
      </button>
      <div className="mt-2 flex items-center justify-center">
        <span className="text-sm text-white/60">Don't have an account?</span>
        <button
          type="button"
          className="ml-2 text-sm font-medium text-[#ff8a3d] hover:underline focus:outline-none"
          onClick={() => router.push('/signup')}
        >
          Sign up
        </button>
      </div>
    </motion.form>
  );
}