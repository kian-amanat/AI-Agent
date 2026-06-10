'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
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
    <form
      className="flex flex-col gap-7 font-sans"
      autoComplete="off"
      onSubmit={handleSubmit}
      spellCheck={false}
    >
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
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition"
          placeholder="Your password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={submitting}
          required
        />
      </div>
      {error && (
        <div className="text-sm text-red-400 px-1 -mt-3">{error}</div>
      )}
      <button
        className="mt-4 flex items-center justify-center bg-gradient-to-r from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d] text-white font-semibold rounded-2xl py-2.5 px-6 shadow-lg transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-[#ff8a3d]/40 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
        type="submit"
        disabled={submitting}
      >
        {submitting ? 'Signing in…' : 'Sign in'}
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
    </form>
  );
}