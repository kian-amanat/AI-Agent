"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

type NotifyOptions = {
  body?:    string;
  tag?:     string;         // dedupes repeat notifications (e.g. same request)
  onClick?: () => void;
};

const supported = typeof window !== "undefined" && "Notification" in window;

// Notification.permission is external browser state. useSyncExternalStore reads
// it without a set-state-in-an-effect (React flags that as a cascading-render
// risk) and keeps SSR/first-client render consistent via the server snapshot.
// The browser has no "permission changed" event, so subscribe is a no-op; the
// value re-reads on any render triggered by request() flipping local state.
function subscribe() { return () => {}; }
function getSnapshot(): NotificationPermission {
  return supported ? Notification.permission : "denied";
}
function getServerSnapshot(): NotificationPermission {
  return "default";
}

/**
 * Browser Web Notifications, opt-in.
 *
 * The caller decides WHEN a notification is worth firing (e.g. the tab is
 * hidden, or the finished task belongs to a session the user isn't looking
 * at) — this hook only owns permission and the actual Notification call, so
 * gating policy stays with the page that has that context.
 */
export function useNotifications() {
  const live = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // request() updates this to force a re-read of the external permission value.
  const [, bump] = useState(0);
  const permission = live;

  const request = useCallback(async (): Promise<NotificationPermission> => {
    if (!supported) return "denied";
    try {
      const p = await Notification.requestPermission();
      bump((n) => n + 1);
      return p;
    } catch {
      return "denied";
    }
  }, []);

  const notify = useCallback((title: string, opts: NotifyOptions = {}) => {
    if (!supported || Notification.permission !== "granted") return;
    try {
      const n = new Notification(title, {
        body: opts.body,
        tag:  opts.tag,
        icon: "/icon.png",
      });
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    } catch {
      /* some browsers throw if called outside a user gesture — ignore */
    }
  }, []);

  return { supported, permission, request, notify };
}
