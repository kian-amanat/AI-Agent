## Expected

Five modules across the tree call `formatMoney`, each with its own `CURRENCY`
constant nearby. All five call sites must be updated to pass it. There are also
three decoy modules that define `CURRENCY` but never call `formatMoney` — editing
those is unnecessary work.

This is breadth, not needle-hunting: nothing is hidden, but the agent must find
*every* affected site. Missing one leaves a caller silently formatting in the
wrong currency, which the validator checks by calling each module's real export.

## Not expected
- A default parameter that lets un-updated call sites keep compiling.
- Editing the decoy modules.
