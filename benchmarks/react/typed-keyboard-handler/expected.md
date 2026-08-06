## Expected

A keyboard handler on the dialog that calls `onClose()` when `e.key === "Escape"`,
and no TODO left behind.

## Why this benchmark exists

This is the minimal isolation of the bug that made `react/command-palette-resume`
unpassable. Writing an idiomatic typed handler means annotating the event —
`(e: React.KeyboardEvent)` — and the pre-write gate in `utils/syntax.util.mjs`
used to reject any file containing `React.<something>` without a
`import React from "react"`, matched by regex over the raw text.

That rule exists to stop a real runtime `ReferenceError` from `React.useRef()`
under the automatic JSX runtime. But a type annotation is erased before the code
runs and cannot throw, so the rule blocked the single most common React+TS
idiom. The file became literally unwritable: three consecutive live runs
retried, hit "old_string not found" patching content that never reached disk,
and ended by printing the component in prose instead of applying it.

So this benchmark is deliberately trivial as a *task* and precise as a *probe*:
if the gate ever regresses to rejecting type positions, this goes red on its own,
without the noise of a ten-check multi-file task.

## Not expected

- Avoiding the type annotation to dodge the gate (`e: any`, or an untyped
  parameter). The point is that the idiomatic version is writable.
- Rewriting `Dialog` beyond adding the handler.
