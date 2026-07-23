/* Kodo notifications service worker.
 *
 * Deliberately minimal: it only shows notifications and handles clicks. It does
 * NOT intercept fetch, so it can't cache anything or interfere with the app.
 * Using the SW's registration.showNotification() (instead of `new Notification`)
 * is what makes notifications reliably appear system-wide while Kodo's tab is
 * in the background or another app is focused.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The page asks the SW to show a notification (so it goes through the SW even
// when the page is backgrounded and `new Notification()` would be throttled).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "show-notification") return;
  const { title, options } = data;
  self.registration.showNotification(title, options || {});
});

// Clicking a notification focuses (or opens) Kodo and tells the page which
// session to open. The page listens for this message.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = clientList.find((c) => "focus" in c) || null;
    if (client) {
      await client.focus();
    } else {
      client = await self.clients.openWindow("/");
    }
    if (client && sessionId) {
      client.postMessage({ type: "notification-click", sessionId });
    }
  })());
});
