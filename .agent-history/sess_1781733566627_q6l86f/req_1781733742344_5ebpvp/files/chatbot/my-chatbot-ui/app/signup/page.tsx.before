'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import SignUpForm from '../components/SignUpForm';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans p-4">
      <motion.div
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="w-full max-w-4xl h-[600px] rounded-3xl shadow-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl flex overflow-hidden relative group"
      >
        {/* Liquid Glass Decorative Side */}
        <div className="hidden md:flex w-2/5 flex-col items-center justify-center p-8 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#ff2d2d]/20 via-[#ff5e4d]/10 to-[#ff8a3d]/5" />
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-[#ff2d2d]/30 rounded-full blur-3xl animate-pulse" />
          <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-[#ff8a3d]/30 rounded-full blur-3xl animate-pulse delay-700" />
          
          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 mb-4 shadow-[0_8px_32px_rgba(255,45,45,0.2)] backdrop-blur-md">
              <Sparkles className="h-8 w-8 text-[#ff5e4d]" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Join Us</h2>
            <p className="text-sm text-white/60">Create your account to unlock all features and start building amazing things.</p>
          </div>
        </div>

        {/* Form Side */}
        <div className="w-full md:w-3/5 p-8 md:p-12 flex flex-col justify-center overflow-y-auto custom-scrollbar relative z-10">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold text-white tracking-tight">Create Account</h1>
            <p className="text-sm text-white/50 mt-2">Get started with your free account today</p>
          </div>

          <div className="flex-1">
            <SignUpForm />
          </div>
        </div>
      </motion.div>
    </div>
  );
}