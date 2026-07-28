"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check, CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, Save,
  Settings as SettingsIcon, Upload, Wifi, WifiOff, X, Zap,
  type LucideIcon,
} from "lucide-react";

import {
  fetchCurrentSettings, saveSettings, testConnection,
  type Capabilities,
} from "../../lib/api";

const DEFAULT_BASE_URL = "https://api.gapgpt.app/v1";

// ── Small building blocks, sized for a 340px rail ──────────────────────────

function SectionRule({ icon: Icon, label, hint }: { icon: LucideIcon; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/25">
        <Icon className="h-2.5 w-2.5 text-[#ff8a3d]" />
        {label}
      </span>
      {hint && <span className="text-[9px] normal-case text-white/15">{hint}</span>}
      <div className="h-px flex-1 bg-white/[0.05]" />
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, password = false, mono = false, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; password?: boolean; mono?: boolean; hint?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-white/30">
        {label}
      </label>
      <div className="relative">
        <input
          type={password && !show ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 ${
            password ? "pr-9" : ""
          } text-[12px] text-white/85 placeholder:text-white/18 outline-none transition-colors focus:border-[#ff8a3d]/40 focus:bg-white/[0.05] ${
            mono ? "font-mono" : ""
          }`}
        />
        {password && (
          <button
            type="button"
            onClick={() => setShow((p) => !p)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 transition-colors hover:text-white/50"
            title={show ? "Hide" : "Show"}
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      {hint && <p className="mt-1 text-[10px] leading-4 text-white/25">{hint}</p>}
    </div>
  );
}

function StatusRow({ active, icon: Icon, title, subtitle }: {
  active: boolean; icon: LucideIcon; title: string; subtitle: string;
}) {
  return (
    <div className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 ${
      active ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-white/[0.05] bg-white/[0.02]"
    }`}>
      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
        active ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.04] text-white/20"
      }`}>
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-white/70">{title}</p>
        <p className="truncate text-[10px] text-white/30">{subtitle}</p>
      </div>
    </div>
  );
}

export default function SettingsSidebar({
  open,
  onClose,
  onSaved,
}: {
  open:     boolean;
  onClose:  () => void;
  /** Fired after a successful save so the app can re-read capabilities. */
  onSaved?: (caps: Capabilities) => void;
}) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loaded,  setLoaded]  = useState(false);
  const requestedRef = useRef(false);   // one-shot guard for the initial fetch

  const [textModel,   setTextModel]   = useState("");
  const [textApiKey,  setTextApiKey]  = useState("");
  const [textBaseUrl, setTextBaseUrl] = useState(DEFAULT_BASE_URL);
  const [showBaseUrl, setShowBaseUrl] = useState(false);

  const [visionEnabled,     setVisionEnabled]     = useState(false);
  const [sameKey,           setSameKey]           = useState(true);
  const [visionModel,       setVisionModel]       = useState("");
  const [visionApiKey,      setVisionApiKey]      = useState("");
  const [visionBaseUrl,     setVisionBaseUrl]     = useState(DEFAULT_BASE_URL);
  const [showVisionBaseUrl, setShowVisionBaseUrl] = useState(false);

  const [saving,     setSaving]     = useState(false);
  const [testing,    setTesting]    = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "success" | "error">("idle");
  const [testMsg,    setTestMsg]    = useState("");
  const [saveError,  setSaveError]  = useState("");

  // Load lazily on first open. Every setState lands in a promise callback
  // rather than the effect body, so opening the panel doesn't cascade renders.
  useEffect(() => {
    if (!open || requestedRef.current) return;
    requestedRef.current = true;

    let cancelled = false;
    fetchCurrentSettings()
      .then(({ settings, capabilities: c }) => {
        if (cancelled) return;
        setCapabilities(c);
        if (settings) {
          setTextModel(settings.textModel || "");
          setTextBaseUrl(settings.textBaseUrl || DEFAULT_BASE_URL);
          if (settings.visionModel) {
            setVisionEnabled(true);
            setVisionModel(settings.visionModel);
            setVisionBaseUrl(settings.visionBaseUrl || DEFAULT_BASE_URL);
          }
        }
      })
      .catch(() => { /* leave the form empty — it can still be filled in and saved */ })
      .finally(() => { if (!cancelled) setLoaded(true); });

    return () => { cancelled = true; };
  }, [open]);

  // Esc closes the panel — matches the rest of the app's overlays.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleTest = useCallback(async () => {
    if (!textModel || !textApiKey) return;
    setTesting(true); setTestStatus("idle"); setTestMsg("");
    try {
      const msg = await testConnection(textModel, textApiKey, textBaseUrl);
      setTestStatus("success"); setTestMsg(msg);
    } catch (err) {
      setTestStatus("error"); setTestMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setTesting(false);
      setTimeout(() => setTestStatus("idle"), 4000);
    }
  }, [textModel, textApiKey, textBaseUrl]);

  const handleSave = useCallback(async () => {
    if (!textModel || !textApiKey) return;
    setSaving(true); setSaveStatus("idle"); setSaveError("");
    try {
      const caps = await saveSettings({
        textModel, textApiKey, textBaseUrl,
        visionModel:   visionEnabled ? visionModel : null,
        visionApiKey:  visionEnabled ? (sameKey ? textApiKey : visionApiKey) : null,
        visionBaseUrl: visionEnabled ? (sameKey ? textBaseUrl : visionBaseUrl) : null,
        useVisionSameKey: sameKey,
      });
      setCapabilities(caps);
      setSaveStatus("success");
      onSaved?.(caps);
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }, [textModel, textApiKey, textBaseUrl, visionEnabled, visionModel, visionApiKey, visionBaseUrl, sameKey, onSaved]);

  // The server never returns stored keys, so a configured account still shows
  // an empty key box. Say so, otherwise the disabled Save button looks broken.
  const keyAlreadyStored = Boolean(capabilities?.chatEnabled) && !textApiKey;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 340, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="flex h-full shrink-0 flex-col overflow-hidden border-l border-white/[0.06] bg-[#141414]"
        >
          {/* Header */}
          <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
            <SettingsIcon className="h-3.5 w-3.5 shrink-0 text-[#ff8a3d]/70" />
            <span className="flex-1 text-[12px] font-semibold text-white/70">Settings</span>
            {!loaded && <Loader2 className="h-3 w-3 animate-spin text-white/25" />}
            <button
              onClick={onClose}
              title="Close"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.05] hover:text-white/70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Body — fixed 340px so nothing reflows while the panel animates */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="flex w-[340px] flex-col gap-4 p-3">

              {/* Current state */}
              {capabilities && (
                <div className="space-y-1.5">
                  <StatusRow
                    active={capabilities.chatEnabled}
                    icon={capabilities.chatEnabled ? Wifi : WifiOff}
                    title="Chat"
                    subtitle={capabilities.chatEnabled ? capabilities.textModel?.model || "" : "Not configured"}
                  />
                  <StatusRow
                    active={capabilities.uploadEnabled}
                    icon={Upload}
                    title="Image upload"
                    subtitle={capabilities.uploadEnabled ? capabilities.visionModel?.model || "" : "Add a vision model"}
                  />
                </div>
              )}

              {/* ── Text model ─────────────────────────────────────────── */}
              <div className="space-y-2.5">
                <SectionRule icon={Zap} label="Text model" />

                <Field
                  label="Model" value={textModel} onChange={setTextModel}
                  placeholder="e.g. claude-sonnet-5" mono
                />
                <Field
                  label="API key" value={textApiKey} onChange={setTextApiKey}
                  placeholder={keyAlreadyStored ? "•••••••• saved" : "sk-…"} password
                  hint={keyAlreadyStored ? "A key is already saved. Re-enter it to change any setting." : undefined}
                />

                <button
                  type="button"
                  onClick={() => setShowBaseUrl((p) => !p)}
                  className="flex items-center gap-1 text-[10px] text-white/22 transition-colors hover:text-white/45"
                >
                  <ChevronDown className={`h-2.5 w-2.5 transition-transform duration-200 ${showBaseUrl ? "rotate-180" : ""}`} />
                  {showBaseUrl ? "Hide" : "Custom"} base URL
                </button>
                <AnimatePresence>
                  {showBaseUrl && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <Field label="Base URL" value={textBaseUrl} onChange={setTextBaseUrl} placeholder={DEFAULT_BASE_URL} mono />
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex flex-wrap items-center gap-2">
                  <motion.button
                    whileTap={{ scale: 0.96 }}
                    onClick={() => void handleTest()}
                    disabled={testing || !textModel || !textApiKey}
                    className="flex items-center gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wifi className="h-3 w-3" />}
                    Test
                  </motion.button>

                  <AnimatePresence>
                    {testStatus !== "idle" && (
                      <motion.span
                        initial={{ opacity: 0, x: -6, scale: 0.9 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className={`flex min-w-0 items-center gap-1 rounded-lg border px-2 py-1 text-[10px] ${
                          testStatus === "success"
                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                            : "border-red-500/20 bg-red-500/10 text-red-400"
                        }`}
                      >
                        {testStatus === "success" ? <CheckCircle2 className="h-2.5 w-2.5 shrink-0" /> : <X className="h-2.5 w-2.5 shrink-0" />}
                        <span className="truncate">{testMsg}</span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* ── Vision model ───────────────────────────────────────── */}
              <div className="space-y-2.5">
                <SectionRule icon={Upload} label="Vision model" hint="optional" />

                <div className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
                  <div className="min-w-0 pr-2">
                    <p className="text-[11px] text-white/60">Enable image uploads</p>
                    <p className="text-[10px] text-white/22">Needed to attach images</p>
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    type="button"
                    onClick={() => setVisionEnabled((p) => !p)}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-300 ${
                      visionEnabled
                        ? "bg-gradient-to-r from-[#ff6a3d] to-[#ffa03d] shadow-[0_0_12px_rgba(255,138,61,0.4)]"
                        : "bg-white/[0.08]"
                    }`}
                    aria-pressed={visionEnabled}
                  >
                    <motion.span
                      layout
                      transition={{ type: "spring", stiffness: 500, damping: 32 }}
                      className={`absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white shadow-md ${
                        visionEnabled ? "left-[calc(100%-17px)]" : "left-[3px]"
                      }`}
                    />
                  </motion.button>
                </div>

                <AnimatePresence>
                  {visionEnabled && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                      className="space-y-2.5 overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => setSameKey((p) => !p)}
                        className="flex w-full items-center gap-2 rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2 text-left"
                      >
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          sameKey ? "border-[#ff8a3d] bg-[#ff8a3d]" : "border-white/15"
                        }`}>
                          {sameKey && <Check className="h-2.5 w-2.5 text-white" />}
                        </span>
                        <span className="text-[11px] text-white/40">Same key &amp; endpoint as text model</span>
                      </button>

                      <Field
                        label="Vision model" value={visionModel} onChange={setVisionModel}
                        placeholder="e.g. claude-opus-4-8" mono
                      />

                      {!sameKey && (
                        <>
                          <Field label="Vision API key" value={visionApiKey} onChange={setVisionApiKey} placeholder="sk-…" password />
                          <button
                            type="button"
                            onClick={() => setShowVisionBaseUrl((p) => !p)}
                            className="flex items-center gap-1 text-[10px] text-white/22 transition-colors hover:text-white/45"
                          >
                            <ChevronDown className={`h-2.5 w-2.5 transition-transform duration-200 ${showVisionBaseUrl ? "rotate-180" : ""}`} />
                            {showVisionBaseUrl ? "Hide" : "Custom"} base URL
                          </button>
                          <AnimatePresence>
                            {showVisionBaseUrl && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <Field label="Vision base URL" value={visionBaseUrl} onChange={setVisionBaseUrl} placeholder={DEFAULT_BASE_URL} mono />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* Save — pinned so it stays reachable however long the form gets */}
          <div className="shrink-0 space-y-2 border-t border-white/[0.06] bg-[#141414] p-3">
            <AnimatePresence>
              {saveStatus === "error" && saveError && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-[10.5px] leading-4 text-red-400/75"
                >
                  {saveError}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => void handleSave()}
              disabled={saving || !textModel || !textApiKey}
              className={`flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                saveStatus === "success"
                  ? "border border-emerald-400/50 bg-emerald-400/10 text-emerald-100"
                  : "border border-[#ff8a3d]/25 bg-gradient-to-br from-[#ff6a3d] to-[#ff2d2d] text-white shadow-[0_8px_20px_rgba(255,77,61,0.18)]"
              }`}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : saveStatus === "success" ? <Check className="h-3.5 w-3.5" />
                : <Save className="h-3.5 w-3.5" />}
              {saving ? "Saving…" : saveStatus === "success" ? "Saved" : "Save settings"}
            </motion.button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
