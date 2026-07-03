---
updated: 2026-07-03T17:41:04.098Z
---

---
updated: 2026-07-03T17:39:56.387Z
---

- ChatSidebar.tsx uses a dot indicator to signal 'no conversations' state
- Condition: `filteredConversations.length === 0`
- Target element: 'New chat' button
- File: `chatbot/my-chatbot-ui/app/components/chat/ChatSidebar.tsx`
- Dot indicator color for 'New chat' button is `#ff8a3d` (orange)
- Always use `motion.div` wrappers for animated elements instead of animating directly on buttons
- Search bar and 'New chat' section in ChatSidebar should use `motion.div` with fade-in and slide-up animation when the sidebar expands
- Search bar input container in ChatSidebar uses `motion.div` with subtle fade-in animation on sidebar expand