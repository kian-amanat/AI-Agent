"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

type NotifyOptions = {
  body?:      string;
  tag?:       string;       // dedupes repeat notifications (e.g. same request)
  sessionId?: string;       // carried into the SW so a click can open that session
  onClick?:   () => void;   // used only by the `new Notification()` fallback path
};

const supported   = typeof window !== "undefined" && "Notification" in window;
const swSupported  = typeof navigator !== "undefined" && "serviceWorker" in navigator;

// The SW registration is module-level so it's shared and only created once,
// regardless of how many components use the hook.
let swRegistration: ServiceWorkerRegistration | null = null;
let swRegistering: Promise<ServiceWorkerRegistration | null> | null = null;

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!swSupported) return null;
  if (swRegistration) return swRegistration;
  if (!swRegistering) {
    swRegistering = navigator.serviceWorker
      .register("/sw.js")
      .then(async (reg) => {
        // Wait until it's active so the very first notification can go through it.
        if (!reg.active) await navigator.serviceWorker.ready;
        swRegistration = reg;
        return reg;
      })
      .catch(() => null);
  }
  return swRegistering;
}

// Notification.permission is external browser state. useSyncExternalStore reads
// it without a set-state-in-an-effect (React flags that as a cascading-render
// risk) and keeps SSR/first-client render consistent via the server snapshot.
function subscribe() { return () => {}; }
function getSnapshot(): NotificationPermission {
  return supported ? Notification.permission : "denied";
}
function getServerSnapshot(): NotificationPermission {
  return "default";
}

/**
 * Browser Web Notifications, opt-in — delivered through a service worker so they
 * appear system-wide even when Kodo's tab is backgrounded or another app is
 * focused (which is exactly when `new Notification()` gets throttled/dropped).
 *
 * The caller decides WHEN a notification is worth firing (e.g. the tab is
 * hidden, or the finished task belongs to a session the user isn't looking at);
 * this hook owns permission + the actual delivery.
 */
export function useNotifications() {
  const live = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [, bump] = useState(0);
  const permission = live;

  const request = useCallback(async (): Promise<NotificationPermission> => {
    if (!supported) return "denied";
    try {
      const p = await Notification.requestPermission();
      bump((n) => n + 1);
      // Pre-register the SW as soon as the user grants, so the first real
      // notification doesn't race the registration.
      if (p === "granted") void ensureServiceWorker();
      return p;
    } catch {
      return "denied";
    }
  }, []);

  const notify = useCallback((title: string, opts: NotifyOptions = {}) => {
    if (!supported || Notification.permission !== "granted") return;

    const options: NotificationOptions = {
      body: opts.body,
      tag:  opts.tag,
      icon: "/icon.png",
      badge: "/icon.png",
      data: { sessionId: opts.sessionId },
    };

    // Preferred path: hand it to the service worker, which reliably shows the
    // notification even when this tab isn't focused.
    void ensureServiceWorker().then((reg) => {
      if (reg) {
        try {
          if (reg.active) {
            reg.active.postMessage({ type: "show-notification", title, options });
          } else {
            void reg.showNotification(title, options);
          }
          return;
        } catch { /* fall through to the direct API */ }
      }
      // Fallback: no service worker available — use the page-scoped API.
      try {
        const n = new Notification(title, options);
        n.onclick = () => { window.focus(); opts.onClick?.(); n.close(); };
      } catch { /* some browsers throw outside a user gesture — ignore */ }
    });
  }, []);

  return { supported, permission, request, notify };
}
