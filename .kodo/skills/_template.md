---
name: my-skill-name
description: One sentence the agent reads to DECIDE whether to load this skill. Make it say when to use it.
triggers: __replace__, __with-keywords__, __that-should-auto-load-this__
---
## Your skill content here

This is a PROJECT-LEVEL skill (lives in .kodo/skills/, owned by you, per-project).
Kodo also has built-in skills in backend1/agents/skills/.

Two ways skills get used:
1. The explore agent reads every skill's name + description and loads relevant ones
   itself via the load_skill tool (Claude Code style, semantic).
2. On creative tasks, skills whose `triggers:` keywords appear in your message are
   injected automatically (deterministic fallback).

To make a "connection" to a library or site (e.g. framer motion): ask Kodo to fetch
its docs page and summarize the key patterns, then paste that summary into a new
.md file here with a good description and triggers. Hot-loaded — no restart needed.

(Note: this template's triggers are deliberately unmatchable and the description
tells the agent it is a template — replace both when you copy this file.)
