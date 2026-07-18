# KODO.md — project instructions for the Kodo agent

Kodo is an AI coding agent (this repo is both the agent AND its test workspace).

## Layout
- `backend1/` — Fastify API on port 9000. The agent brain: LangGraph graph in
  `agents/kodo_graph.mjs` (router → answer | agent_loop), unified tool loop in
  `agents/nodes/agent_loop.mjs`, services in `services/`, config in `config/`.
- `chatbot/my-chatbot-ui/` — Next.js 16 + React 19 chat UI on port 3000.
  App-router pages in `app/`, chat components in `app/components/chat/`,
  landing pages at `app/landing/page.tsx` and `app/landing2/page.tsx`.
- `.kodo/` — agent memory (`memory/`), user skills (`skills/`), hooks (`hooks.json`).

## Commands
- Backend dev: `npm --prefix backend1 run dev` (node server.mjs, port 9000)
- Frontend dev: `npm --prefix chatbot/my-chatbot-ui run dev` (port 3000)
- Frontend typecheck: `npm --prefix chatbot/my-chatbot-ui run typecheck`  ← run after UI edits
- Frontend lint: `npm --prefix chatbot/my-chatbot-ui run lint`
- Backend tests: `npm --prefix backend1 test`
- Backend syntax check: `node --check backend1/<file>.mjs`

## Conventions
- Frontend: TypeScript, Tailwind CSS v4, framer-motion + GSAP for animation,
  lucide-react icons, zustand store (`app/store/chat-store.ts`). Client components
  need `"use client"`; a `"use client"` file must NOT export `metadata`.
- Backend: ESM `.mjs`, no TypeScript. Fastify routes in `routes/`, registered in
  `server.mjs`. LLM access goes through `services/llm.mjs` / `services/agentChat.mjs`.
- Landing pages are dark-theme, cinematic (orange accent #f97316-ish). Respect
  `prefers-reduced-motion` and keep text contrast accessible.

## Gotchas
- Next.js 16 in this repo may differ from your training data — check
  `chatbot/my-chatbot-ui/node_modules/next/dist/docs/` when APIs surprise you.
- `backend1/data/settings.json` holds the user's model config — never commit or overwrite it.
- Don't touch `.env`, `.agent-history/`, `backend1/uploads/`, `backend1/memory.db*`.
