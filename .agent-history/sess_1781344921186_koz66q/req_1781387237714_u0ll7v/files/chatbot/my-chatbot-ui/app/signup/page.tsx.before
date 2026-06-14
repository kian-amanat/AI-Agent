'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import SignUpForm from '../components/SignUpForm';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans">
      <motion.div
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="w-full max-w-md px-8 py-10 rounded-3xl shadow-2xl border border-[#ff8a3d]/20 bg-gradient-to-br from-[#ff8a3d]/10 via-[#ff5e4d]/8 to-[#ff2d2d]/6 backdrop-blur-md flex flex-col items-center"
      >
        <div className="flex flex-col items-center mb-7">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#ff8a3d]/18 bg-white/[0.04] mb-2 shadow-[0_2px_8px_rgba(255,138,61,0.08)]">
            <Sparkles className="h-7 w-7 text-[#ff8a3d]" />
          </div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Create your account</h1>
          <p className="text-sm text-white/38 mt-1">Sign up to get started</p>
        </div>
        <div className="w-full">
          <SignUpForm />
        </div>
      </motion.div>
    </div>
  );
}
