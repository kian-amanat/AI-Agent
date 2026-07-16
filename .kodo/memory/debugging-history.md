---
updated: 2026-07-16T10:00:55.232Z
---

### Bug: TS2322 Property 'showGlow' Does Not Exist
- **Context**: User requested applying a rotating glow effect only to cards in the "Deep Dive into Capabilities" section.
- **Issue**: The AI attempted to pass a `showGlow` prop to a component that did not accept it, causing a TypeScript error: `Type '{ feature: Feature; showGlow: boolean; }' is not assignable to type 'IntrinsicAttributes & { feature: Feature; }'.`
- **Root Cause**: The component definition for the feature cards was not updated to include the `showGlow` prop, or the conditional rendering logic was applied incorrectly to the wrong component level.
- **Lesson**: When adding visual effects to specific sections, ensure the underlying component interfaces are updated to support new props, or use wrapper components/styles instead of prop drilling if the component is shared.

### Bug: Incomplete User Request Handling
- **Context**: User requested modifications to `glow-horizon.tsx` and `landing/page.tsx`.
- **Issue**: The AI model did not return a usable plan (timeout or invalid response), so no files were changed.
- **Lesson**: If the model fails to return a plan, retry the request.

### Bug: Invalid Prop Usage in FeatureCard
- **Context**: User requested removing a backdrop from code while hovering.
- **Issue**: The AI incorrectly identified the issue as an invalid `showGlow={true}` prop on line 586 of `page.tsx` and removed it to fix a TypeScript error.
- **Root Cause**: The user's request was about visual styling (hover backdrop), but the AI interpreted it as a prop validation error. The `showGlow` prop removal was likely a side effect of fixing a pre-existing type error or misinterpretation of the user's intent.
- **Lesson**: When users request visual changes (like removing hover effects), verify if the issue is actually a prop type error or a CSS/styling issue. Do not assume visual requests are always type errors.