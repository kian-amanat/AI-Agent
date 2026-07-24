"use client";

import React, { useRef, useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform, useSpring, useMotionValue, useMotionTemplate, AnimatePresence, type Variants } from "framer-motion";
import {
  ArrowLeft,
  Settings,
  Bell,
  Shield,
  Zap,
  Clock,
  BarChart3,
  User,
  Mail,
  Calendar,
  Award,
  Activity,
  LogOut,
  Palette,
  Globe,
  ChevronRight,
  Sparkles,
  Flame,
  Target,
  MessageSquare,
  X,
  CheckCircle2,
} from "lucide-react";

/* ── Reduced-motion hook (shared with landing2) ── */
function usePrefersReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setPrefersReduced(e.matches);
    handler(mq); // sync initial value via the handler, not a bare setState in the effect body
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return prefersReduced;
}

/* ── Film grain overlay ── */
function FilmGrain() {
  const prefersReduced = usePrefersReducedMotion();
  const noiseSvg = useMemo(
    () =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(%23n)" opacity="0.4"/></svg>`
      )}`,
    []
  );

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[100] overflow-hidden mix-blend-overlay" style={{ opacity: 0.035 }}>
      <motion.div
        className="absolute will-change-transform"
        style={{
          inset: "-150px 0 0 -150px",
          width: "calc(100% + 150px)",
          height: "calc(100% + 150px)",
          backgroundImage: `url(${noiseSvg})`,
          backgroundSize: "150px 150px",
        }}
        animate={prefersReduced ? {} : { x: [0, 150], y: [0, 150] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}

/* ── Ambient glow ── */
function AmbientGlow() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0">
      <motion.div
        animate={{ scale: [1, 1.15, 1], opacity: [0.08, 0.14, 0.08] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
        className="absolute -top-40 -left-40 h-[560px] w-[560px] rounded-full bg-[#ff5e4d] blur-[160px]"
      />
      <motion.div
        animate={{ scale: [1, 1.1, 1], opacity: [0.06, 0.1, 0.06] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        className="absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-[#ff8a3d] blur-[140px]"
      />
    </div>
  );
}

/* ── Mock user data ── */
const MOCK_USER = {
  name: "Alex Morgan",
  username: "alexmorgan",
  email: "alex.morgan@kodo.ai",
  avatar: "AM",
  role: "Pro Member",
  joinedDate: "January 2024",
  stats: {
    conversations: 1247,
    tokensUsed: "2.4M",
    streakDays: 42,
    projects: 18,
  },
  activity: [
    { day: "Mon", value: 65 },
    { day: "Tue", value: 82 },
    { day: "Wed", value: 45 },
    { day: "Thu", value: 91 },
    { day: "Fri", value: 73 },
    { day: "Sat", value: 38 },
    { day: "Sun", value: 56 },
  ],
  recentActivity: [
    { icon: Zap, label: "Generated 1,247 responses", time: "Today", color: "text-[#ff8a3d]" },
    { icon: Target, label: "Completed 3 projects", time: "Yesterday", color: "text-[#ff5e4d]" },
    { icon: Award, label: "Achieved 42-day streak", time: "2 days ago", color: "text-[#ffa03d]" },
    { icon: Activity, label: "Used 2.4M tokens this month", time: "This month", color: "text-[#ff3d3d]" },
  ],
  settings: [
    { icon: Bell, label: "Notifications", desc: "Manage alerts & updates" },
    { icon: Shield, label: "Privacy & Security", desc: "Password, 2FA, sessions" },
    { icon: Palette, label: "Appearance", desc: "Theme, colors, fonts" },
    { icon: Globe, label: "Language", desc: "English (US)" },
    { icon: Settings, label: "Advanced", desc: "API keys, integrations" },
  ],
};

/* ── Stagger variants ── */
const container: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

/* ── Stat card ── */
function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  return (
    <motion.div
      ref={ref}
      variants={item}
      onPointerMove={(e) => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        mouseX.set(e.clientX - rect.left);
        mouseY.set(e.clientY - rect.top);
      }}
      whileHover={{ y: -2, scale: 1.02 }}
      className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1] hover:shadow-[0_20px_40px_rgba(255,138,61,0.08)]"
    >
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{
          background: useMotionTemplate`radial-gradient(400px circle at ${mouseX}px ${mouseY}px, rgba(255,255,255,0.06), transparent 40%)`,
        }}
      />
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <Icon className={`h-5 w-5 ${color}`} />
          <Sparkles className="h-4 w-4 text-white/10" />
        </div>
        <p className="mt-3 text-2xl font-bold text-white">{value}</p>
        <p className="mt-1 text-[12px] text-white/40">{label}</p>
      </div>
    </motion.div>
  );
}

/* ── Activity bar ── */
function ActivityChart() {
  const maxVal = Math.max(...MOCK_USER.activity.map((a) => a.value));

  return (
    <motion.div variants={item} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-6">
      <h3 className="mb-5 text-[13px] font-semibold uppercase tracking-[0.15em] text-white/40">Weekly Activity</h3>
      <div className="flex items-end justify-between gap-2">
        {MOCK_USER.activity.map((day, i) => (
          <motion.div key={day.day} className="flex flex-col items-center gap-2 flex-1" variants={item}>
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: `${(day.value / maxVal) * 120}px`, opacity: 1 }}
              transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.3 + i * 0.08 }}
              className="w-full rounded-t-lg bg-gradient-to-t from-[#ff5e4d] to-[#ff8a3d] opacity-80 hover:opacity-100 transition-opacity"
            />
            <span className="text-[10px] text-white/25">{day.day}</span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

/* ── Feedback modal ── */
// The dashboard is built around a numeric 1–5 rating (stars, distribution,
// filters), so the sentiment selector maps onto that scale when submitted.
const SENTIMENT_TO_RATING: Record<"positive" | "neutral" | "negative", number> = {
  positive: 5,
  neutral: 3,
  negative: 1,
};

function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sentiment, setSentiment] = useState<"" | "positive" | "neutral" | "negative">("");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success">("idle");
  const [error, setError] = useState("");

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setSentiment("");
      setComment("");
      setStatus("idle");
      setError("");
    }, 300);
  };

  const handleSubmit = async () => {
    if (!sentiment || status === "submitting") return;
    setError("");
    setStatus("submitting");
    try {
      const res = await fetch("http://localhost:9000/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: SENTIMENT_TO_RATING[sentiment],
          comment: comment.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data?.error || "Failed to send feedback. Please try again.");
      }
      setStatus("success");
    } catch (err) {
      setStatus("idle");
      setError(
        err instanceof Error && err.message !== "Failed to fetch"
          ? err.message
          : "Couldn't reach the server. Please try again."
      );
    }
  };

  const sentimentOptions = [
    { key: "positive" as const, label: "Great", sublabel: "Loving it" },
    { key: "neutral" as const, label: "Okay", sublabel: "It's fine" },
    { key: "negative" as const, label: "Not great", sublabel: "Needs work" },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-white/[0.06] bg-[#0c0c0f] shadow-[0_40px_100px_rgba(0,0,0,0.6)]"
          >
            <button
              onClick={handleClose}
              aria-label="Close feedback dialog"
              className="absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-white/40 transition-colors hover:bg-white/[0.1] hover:text-white/70"
            >
              <X className="h-3.5 w-3.5" />
            </button>

            {status === "success" ? (
              /* ── Apple-style thank you ── */
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.05 }}
                className="flex flex-col items-center px-8 pb-9 pt-10 text-center"
              >
                {/* Animated checkmark ring */}
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.1 }}
                  className="mb-6 flex h-16 w-16 items-center justify-center rounded-full"
                  style={{
                    background: "radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%)",
                  }}
                >
                  <motion.div
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.25 }}
                  >
                    <CheckCircle2 className="h-8 w-8 text-white/80" />
                  </motion.div>
                </motion.div>

                <motion.h3
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.2 }}
                  className="text-[17px] font-semibold tracking-tight text-white"
                >
                  Thank you
                </motion.h3>

                <motion.p
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.3 }}
                  className="mt-1.5 max-w-[240px] text-[13px] leading-relaxed text-white/35"
                >
                  Your feedback helps us improve. We&apos;ve received your thoughts.
                </motion.p>

                <motion.button
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.4 }}
                  onClick={handleClose}
                  className="mt-7 w-full rounded-xl bg-white/10 py-2.5 text-[13px] font-medium text-white/80 transition-all hover:bg-white/[0.14] hover:text-white active:scale-[0.98]"
                >
                  Done
                </motion.button>
              </motion.div>
            ) : (
              /* ── Feedback form ── */
              <div className="px-7 pb-7 pt-8">
                <h3 className="text-[17px] font-semibold tracking-tight text-white">
                  How was your experience?
                </h3>
                <p className="mt-1 text-[13px] text-white/35">
                  Tap an option below — it only takes a second.
                </p>

                {/* Minimal sentiment selector — no stars */}
                <div className="mt-5 grid grid-cols-3 gap-2">
                  {sentimentOptions.map((opt) => (
                    <motion.button
                      key={opt.key}
                      type="button"
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => setSentiment(opt.key)}
                      className={`flex flex-col items-center justify-center rounded-2xl border py-3.5 transition-all ${
                        sentiment === opt.key
                          ? "border-white/[0.15] bg-white/[0.07]"
                          : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.1] hover:bg-white/[0.04]"
                      }`}
                    >
                      <span
                        className={`text-[13px] font-medium transition-colors ${
                          sentiment === opt.key
                            ? "text-white"
                            : "text-white/50"
                        }`}
                      >
                        {opt.label}
                      </span>
                      <span className="mt-0.5 text-[11px] text-white/25">
                        {opt.sublabel}
                      </span>
                    </motion.button>
                  ))}
                </div>

                {/* Optional comment */}
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder="Anything else you'd like to share? (optional)"
                  className="mt-4 w-full resize-none rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[13px] text-white/75 placeholder-white/20 outline-none transition-colors focus:border-white/[0.12]"
                />

                {/* Error */}
                {error && (
                  <p className="mt-3 text-center text-[12px] text-red-400/80">
                    {error}
                  </p>
                )}

                {/* Submit */}
                <motion.button
                  whileHover={sentiment ? { y: -1 } : {}}
                  whileTap={sentiment ? { scale: 0.98 } : {}}
                  onClick={handleSubmit}
                  disabled={!sentiment || status === "submitting"}
                  className={`mt-4 w-full rounded-xl py-3 text-[13px] font-semibold transition-all ${
                    !sentiment || status === "submitting"
                      ? "cursor-not-allowed bg-white/[0.04] text-white/20"
                      : "bg-white/10 text-white/85 transition-all hover:bg-white/[0.14] hover:text-white active:scale-[0.98]"
                  }`}
                >
                  {status === "submitting" ? "Sending..." : "Send feedback"}
                </motion.button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Profile page ── */
export default function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const [resolved, setResolved] = useState<{ username: string } | null>(null);
  const [hoveredBack, setHoveredBack] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    params.then(setResolved);
  }, [params]);

  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });

  if (!resolved) return null;

  return (
    <div className="relative min-h-screen bg-[#08080a] text-white overflow-hidden">
      {/* Progress bar */}
      <motion.div style={{ scaleX }} className="fixed top-0 inset-x-0 h-1 origin-left z-[60] bg-gradient-to-r from-[#ff5e4d] to-[#ffa03d]" />

      <FilmGrain />
      <AmbientGlow />

      {/* Vignette */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[99]" style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.45) 100%)" }} />

      {/* Content */}
      <div className="relative z-10">
        {/* ── Back button ── */}
        <motion.div variants={item} initial="hidden" animate="visible" className="fixed top-6 left-6 z-50">
          <Link href="/">
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onMouseEnter={() => setHoveredBack(true)}
              onMouseLeave={() => setHoveredBack(false)}
              className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] text-white/60 backdrop-blur-xl transition-all duration-200 hover:border-white/[0.12] hover:text-white/80"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Chat
            </motion.button>
          </Link>
        </motion.div>

        {/* ── Feedback trigger ── */}
        <motion.div variants={item} initial="hidden" animate="visible" className="fixed top-6 right-6 z-50">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setFeedbackOpen(true)}
            className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] text-white/60 backdrop-blur-xl transition-all duration-200 hover:border-white/[0.12] hover:text-white/80"
          >
            <MessageSquare className="h-4 w-4" />
            Feedback
          </motion.button>
        </motion.div>

        {/* ── Hero section ── */}
        <motion.section
          variants={container}
          initial="hidden"
          animate="visible"
          className="relative flex min-h-[420px] flex-col items-center justify-center px-6 pt-24 pb-16 text-center"
        >
          {/* Avatar */}
          <motion.div variants={item} className="relative mb-6">
            {/* Rotating ring */}
            <motion.div
              className="absolute -inset-2 rounded-full"
              style={{
                background: "conic-gradient(from 0deg, #ff8a3d, #ff5e4d, #ff3d3d, #ff8a3d)",
              }}
              animate={{ rotate: prefersReduced ? 0 : 360 }}
              transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
            />
            {/* Avatar circle */}
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-[#08080a] text-3xl font-bold text-white" style={{ boxShadow: "0 0 40px rgba(255,138,61,0.25)" }}>
              {MOCK_USER.avatar}
            </div>
            {/* Online dot */}
            <motion.div
              className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-[#22c55e] border-2 border-[#08080a]"
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          </motion.div>

          {/* Name & role */}
          <motion.h1 variants={item} className="text-4xl md:text-5xl font-bold tracking-tight text-white">
            {MOCK_USER.name}
          </motion.h1>
          <motion.div variants={item} className="mt-2 flex items-center gap-2">
            <span className="rounded-full bg-white/[0.06] px-3 py-1 text-[12px] font-medium text-[#ff8a3d] border border-[#ff8a3d]/20">
              {MOCK_USER.role}
            </span>
            <span className="text-[12px] text-white/30">@{resolved.username}</span>
          </motion.div>
          <motion.p variants={item} className="mt-4 max-w-lg text-lg text-white/50 leading-relaxed">
            Crafting the future, one conversation at a time. Active contributor and power user.
          </motion.p>

          {/* Meta info */}
          <motion.div variants={item} className="mt-6 flex items-center gap-6 text-[12px] text-white/30">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Joined {MOCK_USER.joinedDate}
            </span>
            <span className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {MOCK_USER.email}
            </span>
          </motion.div>
        </motion.section>

        {/* ── Stats grid ── */}
        <section className="px-6 pb-8">
          <motion.div variants={container} initial="hidden" animate="visible" className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
            <StatCard icon={Zap} label="Conversations" value={MOCK_USER.stats.conversations.toLocaleString()} color="text-[#ff8a3d]" />
            <StatCard icon={Activity} label="Tokens Used" value={MOCK_USER.stats.tokensUsed} color="text-[#ff5e4d]" />
            <StatCard icon={Flame} label="Day Streak" value={`${MOCK_USER.stats.streakDays} days`} color="text-[#ffa03d]" />
            <StatCard icon={Target} label="Projects" value={String(MOCK_USER.stats.projects)} color="text-[#ff3d3d]" />
          </motion.div>
        </section>

        {/* ── Activity chart + Recent activity ── */}
        <section className="px-6 pb-8">
          <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ActivityChart />

            {/* Recent activity feed */}
            <motion.div variants={item} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-6">
              <h3 className="mb-5 text-[13px] font-semibold uppercase tracking-[0.15em] text-white/40">Recent Activity</h3>
              <div className="space-y-4">
                {MOCK_USER.recentActivity.map((act, i) => (
                  <motion.div
                    key={i}
                    variants={item}
                    className="flex items-start gap-3 rounded-xl p-3 transition-colors duration-150 hover:bg-white/[0.03]"
                  >
                    <div className={`mt-0.5 rounded-lg bg-white/[0.04] p-2 ${act.color}`}>
                      <act.icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-white/70 leading-snug">{act.label}</p>
                      <p className="mt-0.5 text-[11px] text-white/25">{act.time}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        {/* ── Settings section ── */}
        <section className="px-6 pb-16">
          <motion.div variants={container} initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-80px" }} className="max-w-4xl mx-auto">
            <h2 className="mb-5 text-[13px] font-semibold uppercase tracking-[0.15em] text-white/40">Settings</h2>
            <div className="space-y-2">
              {MOCK_USER.settings.map((setting, i) => (
                <motion.button
                  key={i}
                  variants={item}
                  whileHover={{ x: 4, backgroundColor: "rgba(255,255,255,0.03)" }}
                  whileTap={{ scale: 0.99 }}
                  className="flex w-full items-center justify-between rounded-xl border border-white/[0.04] bg-white/[0.02] px-5 py-4 text-left transition-all duration-150 hover:border-white/[0.08]"
                >
                  <div className="flex items-center gap-4">
                    <div className="rounded-lg bg-white/[0.04] p-2.5">
                      <setting.icon className="h-4 w-4 text-white/50" />
                    </div>
                    <div>
                      <p className="text-[13px] font-medium text-white/80">{setting.label}</p>
                      <p className="text-[11px] text-white/30">{setting.desc}</p>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-white/15" />
                </motion.button>
              ))}
            </div>
          </motion.div>
        </section>

        {/* ── Logout button ── */}
        <section className="px-6 pb-12">
          <div className="max-w-4xl mx-auto">
            <motion.button
              variants={item}
              whileHover={{ scale: 1.02, backgroundColor: "rgba(255,94,77,0.1)" }}
              whileTap={{ scale: 0.98 }}
              className="flex items-center gap-3 rounded-xl border border-white/[0.04] bg-white/[0.02] px-5 py-3.5 text-[13px] text-white/40 transition-all duration-150 hover:text-[#ff5e4d]"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </motion.button>
          </div>
        </section>
      </div>

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}
