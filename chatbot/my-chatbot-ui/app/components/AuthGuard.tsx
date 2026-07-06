"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { apiMe } from "@/app/lib/api";

export default function AuthGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const user = await apiMe();
        setAuthorized(!!user);
      } catch {
        setAuthorized(false);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  if (authorized) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans p-4 overflow-hidden">

      {/* Ambient glow */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-[#ff8a3d]/[0.03] rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative w-full max-w-md"
      >
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl shadow-2xl overflow-hidden">

          {/* Top accent line */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.4, ease: "easeOut", delay: 0.1 }}
            className="h-px bg-gradient-to-r from-transparent via-[#ff8a3d]/50 to-transparent origin-left"
          />

          <div className="p-10 flex flex-col items-center text-center gap-8">

            {/* Icon with pulse rings */}
            <div className="relative flex items-center justify-center w-20 h-20">
              <motion.div
                animate={{ scale: [1, 1.35, 1], opacity: [0.15, 0, 0.15] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                className="absolute inset-0 rounded-full bg-[#ff8a3d]/20"
              />
              <motion.div
                animate={{ scale: [1, 1.6, 1], opacity: [0.08, 0, 0.08] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
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
                {loading ? (
                  <motion.div
                    key="checking"
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
                    <span>Checking authentication</span>
                  </motion.div>
                ) : (
                  <motion.div
                    key="signin"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex items-center gap-1.5 text-sm text-[#ff8a3d]"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>Sign in required</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.h1
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-3xl font-semibold text-white tracking-tight"
              >
                {loading ? "One moment…" : "Please sign in"}
              </motion.h1>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="text-sm text-white/35 max-w-xs leading-relaxed"
              >
                {loading
                  ? "Verifying your session with Kodo."
                  : "You need to be signed in to use Kodo. Sign in to start building with your AI agent."}
              </motion.p>
            </div>

            {/* Divider */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
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
              transition={{ delay: 0.7 }}
              className="w-full"
            >
              <AnimatePresence mode="wait">
                {!loading ? (
                  <motion.button
                    key="active"
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.25 }}
                    onClick={() => router.push("/login")}
                    className="w-full group flex items-center justify-center gap-2 rounded-2xl bg-[#ff8a3d] py-3.5 text-sm font-semibold text-white shadow-lg shadow-orange-500/20 transition-all duration-300 hover:bg-[#ff5e4d] hover:shadow-orange-500/30 active:scale-[0.98]"
                  >
                    Go to Login
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </motion.button>
                ) : (
                  <motion.div
                    key="inactive"
                    className="w-full rounded-2xl bg-white/[0.03] border border-white/[0.06] py-3.5 text-sm text-white/15 text-center select-none"
                  >
                    Go to Login
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

          </div>

          {/* Bottom accent line */}
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.4, ease: "easeOut", delay: 0.3 }}
            className="h-px bg-gradient-to-r from-transparent via-[#ff8a3d]/25 to-transparent origin-right"
          />
        </div>
      </motion.div>
    </div>
  );
}
