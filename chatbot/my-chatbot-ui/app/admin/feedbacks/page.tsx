"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Shield,
  Star,
  Mail,
  Calendar,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Eye,
  Filter,
  Search,
  LogOut,
  MessageSquare,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/* ── Types ─────────────────────────────────────────────────── */

interface FeedbackEntry {
  id: number | string;
  rating: number;
  comment: string | null;
  email: string | null;
  created_at: string;
}

interface AdminResponse {
  ok: boolean;
  feedbacks: FeedbackEntry[];
  total: number;
  error?: string;
}

/* ── Constants ─────────────────────────────────────────────── */

const OWNER_EMAIL = "kian.amanat.9@gmail.com";
const ADMIN_TOKEN_KEY = "kodo_admin_token";

/* ── Helpers ───────────────────────────────────────────────── */

function clearAdminToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function starRating(rating: number) {
  return Array.from({ length: 5 }, (_, i) => (
    <Star
      key={i}
      className={`w-4 h-4 ${
        i < rating ? "text-[#f97316] fill-[#f97316]" : "text-white/15"
      }`}
    />
  ));
}

/* ── Variants ──────────────────────────────────────────────── */

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const } },
};

/* ── Film grain ────────────────────────────────────────────── */

function FilmGrain() {
  const noiseSvg = useMemo(
    () =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(%23n)" opacity="0.4"/></svg>`
      )}`,
    []
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[100] overflow-hidden mix-blend-overlay"
      style={{ opacity: 0.035 }}
    >
      <motion.div
        className="absolute will-change-transform"
        style={{
          inset: "-150px 0 0 -150px",
          width: "calc(100% + 150px)",
          height: "calc(100% + 150px)",
          backgroundImage: `url(${noiseSvg})`,
          backgroundSize: "150px 150px",
        }}
        animate={{ x: [0, 150], y: [0, 150] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}

/* ── Ambient glow ──────────────────────────────────────────── */

function AmbientGlow() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0">
      <motion.div
        animate={{ scale: [1, 1.15, 1], opacity: [0.06, 0.12, 0.06] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
        className="absolute -top-40 -left-40 h-[560px] w-[560px] rounded-full bg-[#ff5e4d] blur-[160px]"
      />
      <motion.div
        animate={{ scale: [1, 1.1, 1], opacity: [0.04, 0.08, 0.04] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        className="absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-[#ff8a3d] blur-[140px]"
      />
    </div>
  );
}

/* ── Login Gate ────────────────────────────────────────────── */

function AdminLogin({ onLogin }: { onLogin: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    await new Promise((r) => setTimeout(r, 600));

    if (email === OWNER_EMAIL && password === "19kian95") {
      onLogin(email);
      router.push("/admin/feedbacks");
    } else {
      setError("Invalid admin credentials. Access denied.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans p-4 overflow-hidden relative">
      <FilmGrain />
      <AmbientGlow />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative w-full max-w-md z-10"
      >
        <div className="rounded-3xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-2xl shadow-2xl overflow-hidden">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.2, ease: "easeOut", delay: 0.1 }}
            className="h-px bg-gradient-to-r from-transparent via-[#f97316]/50 to-transparent origin-left"
          />

          <div className="p-10 flex flex-col items-center text-center gap-7">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-[#f97316]/10 border border-[#f97316]/20"
            >
              <Shield className="w-7 h-7 text-[#f97316]" />
            </motion.div>

            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-semibold text-white tracking-tight">
                Admin Access
              </h1>
              <p className="text-sm text-white/30 max-w-xs leading-relaxed">
                Enter your admin credentials to access the feedback dashboard.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
              <div className="flex flex-col gap-1.5 text-left">
                <label className="text-xs font-medium text-white/40 uppercase tracking-wider">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@kodo.ai"
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-[#f97316]/40 focus:border-[#f97316]/40 transition-all"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5 text-left">
                <label className="text-xs font-medium text-white/40 uppercase tracking-wider">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-[#f97316]/40 focus:border-[#f97316]/40 transition-all"
                  required
                />
              </div>

              <AnimatePresence mode="wait">
                {error && (
                  <motion.div
                    key="error"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 rounded-xl bg-[#f97316] text-white font-medium text-sm py-3 hover:bg-[#ea6510] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Shield className="w-4 h-4" />
                    Sign In
                  </>
                )}
              </button>
            </form>

            <Link
              href="/"
              className="text-xs text-white/25 hover:text-white/40 transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3 h-3" />
              Back to Kodo
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Feedback Card ─────────────────────────────────────────── */

function FeedbackCard({
  fb,
  onDelete,
}: {
  fb: FeedbackEntry;
  onDelete: (id: number | string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetch(
        `http://localhost:9000/api/feedback/${fb.id}?email=${encodeURIComponent(OWNER_EMAIL)}`,
        { method: "DELETE" }
      );
      onDelete(fb.id);
    } catch {
      setDeleting(false);
    }
  };

  return (
    <motion.div
      variants={item}
      className="group relative rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden transition-all duration-300 hover:border-white/[0.1] hover:bg-white/[0.04]"
    >
      <div className="h-1 bg-gradient-to-r from-[#f97316] to-[#ff5e4d]" style={{ width: `${(fb.rating / 5) * 100}%` }} />

      <div className="p-5">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-0.5">
              {starRating(fb.rating)}
            </div>
            <span className="text-xs text-white/30 font-mono">#{fb.id}</span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/25 hover:text-white/50 transition-all"
              title={expanded ? "Collapse" : "Expand"}
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-all disabled:opacity-30"
              title="Delete feedback"
            >
              {deleting ? (
                <div className="w-3.5 h-3.5 border-1.5 border-red-400/30 border-t-red-400 rounded-full animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        <div className="mb-3">
          {fb.comment ? (
            <p
              className={`text-sm text-white/60 leading-relaxed transition-all duration-300 ${
                expanded ? "" : "line-clamp-2"
              }`}
            >
              {fb.comment}
            </p>
          ) : (
            <p className="text-sm text-white/20 italic">No comment provided</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-white/25">
          <span className="flex items-center gap-1.5">
            <Mail className="w-3 h-3" />
            {fb.email || "Anonymous"}
          </span>
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            {formatDate(fb.created_at)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

/* ── Stats Bar ─────────────────────────────────────────────── */

function StatsBar({ feedbacks }: { feedbacks: FeedbackEntry[] }) {
  const avgRating = useMemo(() => {
    if (feedbacks.length === 0) return 0;
    return (feedbacks.reduce((s, f) => s + f.rating, 0) / feedbacks.length).toFixed(1);
  }, [feedbacks]);

  const ratingDist = useMemo(() => {
    const dist = [0, 0, 0, 0, 0];
    feedbacks.forEach((f) => dist[f.rating - 1]++);
    return dist;
  }, [feedbacks]);

  const maxDist = Math.max(...ratingDist, 1);

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
        <div className="text-2xl font-semibold text-white">{feedbacks.length}</div>
        <div className="text-xs text-white/30 mt-1">Total Feedback</div>
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
        <div className="text-2xl font-semibold text-[#f97316]">{avgRating}</div>
        <div className="text-xs text-white/30 mt-1">Avg Rating</div>
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
        <div className="text-2xl font-semibold text-[#22c55e]">{ratingDist[4]}</div>
        <div className="text-xs text-white/30 mt-1">5 Stars</div>
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-center">
        <div className="text-2xl font-semibold text-red-400">{ratingDist[0]}</div>
        <div className="text-xs text-white/30 mt-1">1 Star</div>
      </div>

      <div className="col-span-2 md:col-span-1 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 flex items-center justify-center gap-1">
        {ratingDist.map((count, i) => (
          <div
            key={i}
            className="w-3 rounded-full bg-[#f97316] transition-all duration-500"
            style={{ height: `${Math.max((count / maxDist) * 32, 4)}px` }}
            title={`${5 - i} stars: ${count}`}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Main Dashboard ────────────────────────────────────────── */

function AdminDashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [feedbacks, setFeedbacks] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterRating, setFilterRating] = useState(0);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const fetched = useRef(false);

  const fetchFeedbacks = async () => {
    try {
      const res = await fetch(
        `http://localhost:9000/api/feedback/admin?email=${encodeURIComponent(OWNER_EMAIL)}`
      );
      const data: AdminResponse = await res.json();
      if (data.ok) {
        setFeedbacks(data.feedbacks);
      } else {
        setToast({ type: "error", msg: data.error || "Failed to load feedbacks" });
      }
    } catch {
      setToast({ type: "error", msg: "Failed to connect to server" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!fetched.current) {
      fetched.current = true;
      fetchFeedbacks();
    }
  }, []);

  const handleDelete = (id: number | string) => {
    setFeedbacks((prev) => prev.filter((f) => f.id !== id));
    setToast({ type: "success", msg: "Feedback deleted" });
    setTimeout(() => setToast(null), 3000);
  };

  const filtered = useMemo(() => {
    return feedbacks.filter((f) => {
      const matchesSearch =
        !search ||
        f.comment?.toLowerCase().includes(search.toLowerCase()) ||
        f.email?.toLowerCase().includes(search.toLowerCase());
      const matchesRating = filterRating === 0 || f.rating === filterRating;
      return matchesSearch && matchesRating;
    });
  }, [feedbacks, search, filterRating]);

  return (
    <div className="min-h-screen bg-[#161616] font-sans relative overflow-hidden">
      <FilmGrain />
      <AmbientGlow />

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -16, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: -16, x: "-50%" }}
            className={`fixed top-6 left-1/2 z-[200] rounded-xl px-5 py-3 text-sm font-medium shadow-2xl flex items-center gap-2 ${
              toast.type === "success"
                ? "bg-green-500/20 border border-green-500/30 text-green-300"
                : "bg-red-500/20 border border-red-500/30 text-red-300"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="relative z-10 border-b border-white/[0.06] bg-[#161616]/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/40 hover:text-white/70 transition-all">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-white tracking-tight flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#f97316]" />
                Feedback Dashboard
              </h1>
              <p className="text-xs text-white/25">Admin Panel — {email}</p>
            </div>
          </div>

          <button
            onClick={onLogout}
            className="flex items-center gap-2 text-xs text-white/30 hover:text-red-400 transition-colors px-3 py-2 rounded-lg hover:bg-white/[0.04]"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 py-8">
        {!loading && feedbacks.length > 0 && <StatsBar feedbacks={feedbacks} />}

        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search comments or emails…"
              className="w-full rounded-xl border border-white/[0.06] bg-white/[0.03] pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-[#f97316]/30 focus:border-[#f97316]/30 transition-all"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-white/20 shrink-0" />
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4, 5].map((r) => (
                <button
                  key={r}
                  onClick={() => setFilterRating(r)}
                  className={`w-9 h-9 rounded-lg text-xs font-medium transition-all ${
                    filterRating === r
                      ? "bg-[#f97316] text-white"
                      : "bg-white/[0.04] text-white/30 hover:bg-white/[0.08] hover:text-white/50"
                  }`}
                >
                  {r === 0 ? "All" : `${r}★`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-8 h-8 border-2 border-white/10 border-t-[#f97316] rounded-full animate-spin" />
            <p className="text-sm text-white/25">Loading feedbacks…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
              <MessageSquare className="w-6 h-6 text-white/15" />
            </div>
            <p className="text-sm text-white/25">
              {feedbacks.length === 0
                ? "No feedbacks yet. They'll appear here when users submit them."
                : "No feedbacks match your filters."}
            </p>
          </div>
        ) : (
          <motion.div variants={container} initial="hidden" animate="visible" className="grid gap-3">
            {filtered.map((fb) => (
              <FeedbackCard key={fb.id} fb={fb} onDelete={handleDelete} />
            ))}
          </motion.div>
        )}
      </main>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────── */

export default function AdminFeedbackPage() {
  const hasToken = typeof window !== "undefined" && localStorage.getItem(ADMIN_TOKEN_KEY) !== null;
  const [authenticated, setAuthenticated] = useState(hasToken);
  const [adminEmail, setAdminEmail] = useState(hasToken ? OWNER_EMAIL : "");
  const router = useRouter();

  const handleLogin = (email: string) => {
    setAuthenticated(true);
    setAdminEmail(email);
  };

  const handleLogout = () => {
    clearAdminToken();
    setAuthenticated(false);
    setAdminEmail("");
    router.push("/");
  };

  if (!authenticated) {
    return <AdminLogin onLogin={handleLogin} />;
  }

  return <AdminDashboard email={adminEmail} onLogout={handleLogout} />;
}
