'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

export default function SignUpForm() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // TODO: Implement actual signup logic
      await new Promise((resolve) => setTimeout(resolve, 800));
      // On success, redirect to login or home
      router.push('/login');
    } catch (err) {
      setError('Failed to sign up. Please try again.');
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
        <label htmlFor="phone" className="text-sm text-white/70 font-medium px-1">
          Phone (optional)
        </label>
        <input
          id="phone"
          type="tel"
          autoComplete="tel"
          className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition"
          placeholder="Your phone number"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          disabled={submitting}
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
            autoComplete="new-password"
            className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition w-full pr-12"
            placeholder="Create a password"
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
      <div className="flex flex-col gap-2">
        <label htmlFor="confirmPassword" className="text-sm text-white/70 font-medium px-1">
          Re-enter Password
        </label>
        <div className="relative">
          <input
            id="confirmPassword"
            type={showConfirmPassword ? 'text' : 'password'}
            autoComplete="new-password"
            className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-white/90 placeholder:text-white/30 focus:border-[#ff8a3d]/40 focus:outline-none transition w-full pr-12"
            placeholder="Re-enter password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            disabled={submitting}
            required
          />
          <button
            type="button"
            tabIndex={-1}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white/80 focus:outline-none"
            onClick={() => setShowConfirmPassword(v => !v)}
            aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
          >
            {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
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
        {submitting ? 'Signing up…' : 'Sign up'}
      </button>
      <div className="mt-2 flex items-center justify-center">
        <span className="text-sm text-white/60">Already have an account?</span>
        <button
          type="button"
          className="ml-2 text-sm font-medium text-[#ff8a3d] hover:underline focus:outline-none"
          onClick={() => router.push('/login')}
        >
          Sign in
        </button>
      </div>
    </form>
  );
}