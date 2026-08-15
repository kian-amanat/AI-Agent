'use client';

import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ArrowRight, Folder, Zap } from 'lucide-react';
import { apiMe, stagePendingWorkspace } from '../lib/api';

function ConnectPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projectName, setProjectName] = useState('your project');
  const [phase, setPhase] = useState<'connecting' | 'connected'>('connecting');

  useEffect(() => {
    const workspace = searchParams.get('workspace');

    (async () => {
      if (workspace) {
        const parts = workspace.split('/').filter(Boolean);
        const name = parts[parts.length - 1] || workspace;
        setProjectName(name);
        // Stage the REAL path (not just the display name) so login/signup can
        // bind the new session to this exact project instead of falling back
        // to whatever the server considers "the" workspace.
        stagePendingWorkspace(workspace, name);

        // A token already sitting in this browser might belong to a DIFFERENT
        // project (e.g. the extension opened a new file while a previous
        // project's session was still active). Opening a different project
        // must never silently reuse someone else's — or a different
        // project's — identity, so if the bound workspace doesn't match what
        // was just opened, force a fresh login.
        const existing = await apiMe().catch(() => null);
        if (existing) {
          const boundPath = typeof window !== 'undefined' ? localStorage.getItem('kodo_workspace_path') : null;
          if (boundPath && boundPath !== workspace) {
            localStorage.removeItem('kodo_token');
            localStorage.removeItem('kodo_session_id');
            localStorage.removeItem('kodo_workspace_path');
          }
        }
      } else {
        const storedName = localStorage.getItem('kodo_pending_workspace_name') || localStorage.getItem('kodo_workspace_name');
        if (storedName) setProjectName(storedName);
      }
    })();

    const timer = setTimeout(() => setPhase('connected'), 1800);
    return () => clearTimeout(timer);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans p-4 overflow-hidden">

      {/* Subtle ambient — toned way down */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-[#ff8a3d]/[0.03] rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative w-full max-w-md"
      >
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl shadow-2xl overflow-hidden">

          {/* Top accent line */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.4, ease: 'easeOut', delay: 0.1 }}
            className="h-px bg-gradient-to-r from-transparent via-[#ff8a3d]/50 to-transparent origin-left"
          />

          <div className="p-10 flex flex-col items-center text-center gap-8">

            {/* Pure icon.png with subtle pulse rings only */}
            <div className="relative flex items-center justify-center w-20 h-20">
              <motion.div
                animate={{ scale: [1, 1.35, 1], opacity: [0.15, 0, 0.15] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="absolute inset-0 rounded-full bg-[#ff8a3d]/20"
              />
              <motion.div
                animate={{ scale: [1, 1.6, 1], opacity: [0.08, 0, 0.08] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
                className="absolute inset-0 rounded-full bg-[#ff8a3d]/10"
              />
              <motion.div
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.2 }}
              >
                <Image
                  src="/icon.png"
                  alt="Kodo"
                  width={56}
                  height={56}
                  className="object-contain"
                />
              </motion.div>
            </div>

            {/* Status + text */}
            <div className="flex flex-col items-center gap-3">
              <AnimatePresence mode="wait">
                {phase === 'connecting' ? (
                  <motion.div
                    key="connecting"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.25 }}
                    className="flex items-center gap-2 text-sm text-white/35"
                  >
                    <div className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                          className="w-1 h-1 rounded-full bg-[#ff8a3d]"
                        />
                      ))}
                    </div>
                    <span>Connecting workspace</span>
                  </motion.div>
                ) : (
                  <motion.div
                    key="connected"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex items-center gap-1.5 text-sm text-[#ff8a3d]"
                  >
                    <Zap className="w-3.5 h-3.5 fill-[#ff8a3d]" />
                    <span>Connected</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.h1
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-3xl font-semibold text-white tracking-tight"
              >
                Kodo is ready
              </motion.h1>

              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/[0.04]"
              >
                <Folder className="w-3.5 h-3.5 text-white/35" />
                <span className="text-sm text-white/60 font-mono">{projectName}</span>
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="text-sm text-white/35 max-w-xs leading-relaxed"
              >
                Your VS Code workspace is linked. Sign in to start building with your AI agent.
              </motion.p>
            </div>

            {/* Divider */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.7 }}
              className="w-full flex items-center gap-3"
            >
              <div className="flex-1 h-px bg-white/[0.06]" />
              <div className="w-1 h-1 rounded-full bg-[#ff8a3d]/30" />
              <div className="flex-1 h-px bg-white/[0.06]" />
            </motion.div>

            {/* Button */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="w-full"
            >
              <AnimatePresence mode="wait">
                {phase === 'connected' ? (
                  <motion.button
                    key="active"
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.25 }}
                    onClick={() => router.push('/login')}
                    className="w-full group flex items-center justify-center gap-2 rounded-2xl bg-[#ff8a3d] py-3.5 text-sm font-semibold text-white shadow-lg shadow-orange-500/20 transition-all duration-300 hover:bg-[#ff5e4d] hover:shadow-orange-500/30 active:scale-[0.98]"
                  >
                    Continue to Sign In
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </motion.button>
                ) : (
                  <motion.div
                    key="inactive"
                    className="w-full rounded-2xl bg-white/[0.03] border border-white/[0.06] py-3.5 text-sm text-white/15 text-center select-none"
                  >
                    Continue to Sign In
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

          </div>

          {/* Bottom accent line */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.4, ease: 'easeOut', delay: 0.3 }}
            className="h-px bg-gradient-to-r from-transparent via-[#ff8a3d]/25 to-transparent origin-right"
          />
        </div>
      </motion.div>
    </div>
  );
}

/**
 * useSearchParams() opts a route into client-side rendering, and Next refuses
 * to prerender it without a Suspense boundary — which failed the production
 * build outright, so this UI could only ever run under `next dev`. Wrapping the
 * reader in Suspense lets the shell prerender and the query-string-dependent
 * part hydrate on the client, which is what the page already did in practice.
 */
export default function ConnectPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <ConnectPageInner />
    </Suspense>
  );
}
