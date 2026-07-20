---
updated: 2026-07-19T13:37:51.727Z
---

### UI Component Patterns (2026-07-19)
- **File**: `chatbot/my-chatbot-ui/components/ui/n8n-workflow-block-shadcnui.tsx`
- **Dependencies**: Uses `framer-motion` for animations, `lucide-react` for icons (`ArrowRight`, `Database`, `Mail`, `Plus`, `Settings`).
- **Shadcn UI Components**: Relies on local shadcn components: `Badge`, `Button`, `Card`.
- **React Patterns**:
  - Uses `useRef` and `useState` for state management.
  - Uses `flushSync` from `react-dom` for synchronous DOM updates.
  - Imports `React` explicitly when using `React.ComponentType` or similar types.
- **Note**: Ensure `React` is imported if `React.ComponentType` or JSX factory functions are used directly.

### Landing Page Component Updates (2026-07-19)
- **File**: `chatbot/my-chatbot-ui/app/landing2/page.tsx`
- **Action**: Replaced `<ParallaxFeatureStrip />` with `<KodoInActionSection />`.
- **Imports Added**:
  - `Card`, `CardHeader`, `CardContent`, `CardTitle`, `CardDescription` from `@/components/ui/card`
  - `Badge` from `@/components/ui/badge`
  - `Button` from `/components/ui/button`
- **Status**: Partial progress. Old `PARALLAX_FEATURES` array and `ParallaxFeatureCard` component remain in file but are no longer used by the main section.
