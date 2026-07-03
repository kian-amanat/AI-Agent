---
updated: 2026-07-03T22:36:39.963Z
---

- Project uses Next.js with TypeScript config (`next.config.ts`)
- Frontend UI located in `chatbot/my-chatbot-ui/`
- Image quality configuration requires explicit list in `images.qualities`
- Current config has `[75]`, warning triggered by usage of quality `100`
- Fix applied: Updated `next.config.ts` to include `100` in `images.qualities` array alongside `75`