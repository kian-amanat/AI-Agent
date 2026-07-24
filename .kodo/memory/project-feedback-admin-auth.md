---
name: project-feedback-admin-auth
description: Admin-only feedback route with hardcoded email auth
metadata:
  type: project
updated: 2026-07-24T17:31:56.595Z
---

- **Route**: `/admin/feedbacks` in `chatbot/my-chatbot-ui/app/admin/feedbacks/page.tsx`
- **Access Control**: Hardcoded email authentication. Only `kian.amanat.9@gmail.com` can access.
- **Credentials**: Password is `kodo_admin_2024` (stored in frontend `localStorage` for session persistence).
- **Functionality**: Displays a dashboard with stats (total feedback, average rating) and a list of all user feedback entries.
- **Backend**: Integrated with `backend1/routes/feedback.mjs` to fetch feedback data.
- **Note**: This is a simple, hardcoded auth mechanism for a specific admin user, not a general auth system.