---
updated: 2026-07-12T20:23:08.582Z
---

### Icon Styling Requirements
- **Background Removal**: Settings page buttons must use only `icon.png` without additional backgrounds. Check parent elements for background classes (e.g., `bg-*`, `rounded-*`) that may require removal.
- **Size Adjustment**: Icon requires explicit sizing (e.g., `h-12 w-12` or `style={{width: '48px', height: '48px'}}`). Avoid relying on container padding for perceived size.
- **Component Update**: Use `Sparkles` component instead of Lucide icons for settings page buttons
- **Material UI Integration**: For semantic icons, replace current components with Material UI equivalents (e.g., `ChatIcon`, `UploadIcon`, `AddPhotoAlternateIcon`, `LockIcon`, `DesktopWindowsIcon`)
- **New Semantic Icons**: User requested specific mappings for:
  - Chat → `ChatIcon`
  - File Upload → `UploadIcon`
  - Add vision model → `AddPhotoAlternateIcon`
  - Local only → `DesktopWindowsIcon`
  - Keys never leave → `LockIcon`

### Success-State Button Design
- `chatbot/my-chatbot-ui/app/components/chat/AssistantMessage.tsx` remains reference for clicked/success button styling
- Reuse Revert button's success-state classes and feedback content for consistent animations
- **Enhancement Focus**: Save Changes button in `/settings/page.tsx` now features:
  - Premium red-orange