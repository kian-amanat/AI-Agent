## Expected

`utils.ts` gains an exported `formatCurrency(amount: number): string` that renders a
number as USD with exactly two decimal places and a leading `$`.

`App.tsx` **imports and calls** it to render the price 42.5. Adding the helper and
leaving `App.tsx` untouched is the classic half-done outcome this benchmark exists
to catch: the helper is only useful if it is wired up.

Both files must still parse as valid TypeScript/TSX afterwards.

## Not expected

- Rewriting `slugify`, or restructuring either file beyond the change asked for.
- Hardcoding the string `"$42.50"` in `App.tsx` instead of calling the helper.
