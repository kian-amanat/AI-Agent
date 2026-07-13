---
updated: 2026-07-13T20:00:42.152Z
---

### Bug: Module not found errors in new components
- **Root Cause**: Incorrect import paths for local components (e.g., `@/components/ui/magnetic-button` not found)
- **Fix**: 
  1. Use relative paths for components in the same directory
  2. Verify project-specific path aliases in tsconfig.json/vite.config.ts
  3. Run `npm run typecheck` to validate imports
- **New Case**: Missing `Lock` component import from `lucide-react` caused JSX error
- **Validation**: 
  - TS2307 errors resolved by correct path resolution
  - Ensure all new components use project-specific import conventions