/**
 * src/server/ui.mjs — the built-in web UI shell.
 *
 * Deliberately one self-contained page with no build step. `kodo ui` has to
 * work immediately after `curl … | sh`, on a machine with no npm install and no
 * Next.js toolchain; a UI that first needs a bundler is a UI that does not
 * exist for most of the people running that command.
 *
 * The richer Next.js UI in chatbot/my-chatbot-ui remains the full product
 * surface and talks to the backend1 server (`kodo server`). Porting it onto
 * this local API is tracked as remaining work — see docs/architecture.md.
 *
 * The page holds the runtime token in memory only. It is supplied via the URL
 * fragment (#token=…), which browsers never send to the server and which is not
 * recorded in server logs or Referer headers, and is stripped from the address
 * bar as soon as it is read.
 */

export function renderUi({ version, workspace }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Kodo</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --code:#f6f7f9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e6e8ec; --muted:#9aa1ad; --line:#252932; --accent:#6ea8fe; --code:#171a21; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 ui-sans-serif,-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
  header b { font-size:15px; letter-spacing:.02em; }
  header span { color:var(--muted); font-size:12px; }
  main { max-width:900px; margin:0 auto; padding:20px; }
  #log { display:flex; flex-direction:column; gap:14px; min-height:50vh; }
  .msg { padding:12px 14px; border:1px solid var(--line); border-radius:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .user { background:var(--code); }
  .trace { color:var(--muted); font-size:12.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; border:0; padding:2px 0; }
  .file { color:var(--accent); font-size:12.5px; font-family:ui-monospace,monospace; padding:2px 0; }
  form { display:flex; gap:8px; margin-top:20px; position:sticky; bottom:0; background:var(--bg); padding:12px 0; }
  textarea { flex:1; resize:vertical; min-height:52px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--fg); font:inherit; }
  button { padding:0 18px; border:0; border-radius:10px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .warn { color:#b45309; }
</style>
</head>
<body>
<header>
  <b>KODO</b>
  <span>v${esc(version)}</span>
  <span>${esc(workspace)}</span>
  <span id="state">connecting…</span>
</header>
<main>
  <div id="log"></div>
  <form id="composer">
    <textarea id="input" placeholder="Ask Kodo to change something in this project…" autofocus></textarea>
    <button id="send" type="submit">Send</button>
  </form>
</main>
<script>
(() => {
  // Read the token from the fragment, then remove it from the address bar so it
  // does not survive in history or get shoulder-surfed.
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  history.replaceState(null, "", location.pathname);

  const log = document.getElementById("log");
  const state = document.getElementById("state");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  let sessionId = null, streaming = false, current = null;

  const auth = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
  const add = (cls, text) => {
    const el = document.createElement("div");
    el.className = cls; el.textContent = text; log.appendChild(el);
    window.scrollTo(0, document.body.scrollHeight);
    return el;
  };

  async function ensureSession() {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", { method: "POST", headers: auth, body: "{}" });
    if (!res.ok) throw new Error("could not create a session (" + res.status + ")");
    sessionId = (await res.json()).session.id;
    listen();
    return sessionId;
  }

  function listen() {
    const es = new EventSource("/api/sessions/" + sessionId + "/events?token=" + encodeURIComponent(token));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "agent_message") {
        if (!current) current = add("msg", "");
        current.textContent += e.text;
        window.scrollTo(0, document.body.scrollHeight);
      } else if (e.type === "agent_progress") {
        add("trace", "· " + e.message);
      } else if (e.type === "file_changed") {
        add("file", "● " + e.action + " " + e.path);
      } else if (e.type === "agent_error") {
        add("msg warn", "Error: " + e.error);
      } else if (e.type === "session_completed") {
        streaming = false; current = null;
        send.disabled = false; state.textContent = "idle";
      }
    };
    es.onerror = () => { state.textContent = "disconnected"; };
    state.textContent = "idle";
  }

  document.getElementById("composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const message = input.value.trim();
    if (!message || streaming) return;
    input.value = "";
    add("msg user", message);
    streaming = true; send.disabled = true; state.textContent = "working…";
    try {
      const id = await ensureSession();
      const res = await fetch("/api/sessions/" + id + "/messages", {
        method: "POST", headers: auth, body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      add("msg warn", "Error: " + err.message);
      streaming = false; send.disabled = false; state.textContent = "idle";
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) document.getElementById("composer").requestSubmit();
  });

  if (!token) {
    state.textContent = "no token";
    add("msg warn", "This page was opened without a runtime token, so it cannot talk to the agent. Start it with 'kodo ui start --open', or use the URL printed by 'kodo ui status'.");
    send.disabled = true;
  } else {
    ensureSession().catch((e) => add("msg warn", "Error: " + e.message));
  }
})();
</script>
</body>
</html>`;
}
